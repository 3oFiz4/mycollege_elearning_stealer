const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");
const fs = require("fs");
const path = require("path");

// --- CONFIG ---
const MY_PHONE_NUMBER = process.env.WHATSAPP_PHONE_NUMBER;
const TARGET_COMMUNITY_NAME = "Reminder 🔔";
const TARGET_ANNOUNCE_GROUP_NAME = "Pengumuman";
const TARGET_GROUP_JID = process.env.WHATSAPP_GROUP_JID;

const DEFAULT_ALERT_MESSAGE =
  "⚠️ E-Learning Alert: Default notification check.";
const SEND_ON_EMPTY = true;

// Debug configuration: offset current date by N days forward (e.g. 3) to test deadline urgency & mentions
const DEBUG_DATE_OFFSET_DAYS = 0;

/**
 * Format homework items into a clean WhatsApp message
 */
function formatWhatsAppMessage(items) {
  if (!items || items.length === 0) {
    return (
      "*PENGINGAT TUGAS E-LEARNING*\n\n" +
      "Tidak ada tugas yang pending hari ini. Ngopi dlu ygy :333333! ✨✨✨✨✨✨✨"
    );
  }

  const simulatedDate = new Date();
  if (DEBUG_DATE_OFFSET_DAYS) {
    simulatedDate.setDate(simulatedDate.getDate() + DEBUG_DATE_OFFSET_DAYS);
  }

  const todayStr = simulatedDate.toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  // If items have daysDiff calculated without debug offset, adjust it by DEBUG_DATE_OFFSET_DAYS
  const adjustedItems = items.map((hw) => ({
    ...hw,
    daysDiff: DEBUG_DATE_OFFSET_DAYS
      ? Number(hw.daysDiff) - DEBUG_DATE_OFFSET_DAYS
      : Number(hw.daysDiff),
  }));

  const hasUrgent = adjustedItems.some((hw) => Number(hw.daysDiff) <= 2);
  const tagHeader = hasUrgent ? "🚨 *PERINGATAN DEADLINE DEKAT!* 🚨\n\n" : "";

  let msg = tagHeader;
  msg += "eLEARNING HOMEWORK REMINDER \n";
  msg += `${todayStr}${DEBUG_DATE_OFFSET_DAYS ? ` (Simulasi +${DEBUG_DATE_OFFSET_DAYS} Hari)` : ""}\n`;
  msg += "━━━━━━━━━━━━━━━━━━━━━\n\n";

  adjustedItems.forEach((hw, i) => {
    let urgencyEmoji = "⚪";
    if (hw.daysDiff <= 0) {
      const passedDays = Math.abs(hw.daysDiff);
      urgencyEmoji =
        passedDays === 0
          ? "⚠️ *TELAH BERAKHIR HARI INI*"
          : `⚠️ *TELAH LEWAT ${passedDays} HARI*`;
    } else if (hw.daysDiff <= 1) {
      urgencyEmoji = "🚨 *HARI INI / BESOK*";
    } else if (hw.daysDiff <= 2) {
      urgencyEmoji = "🔴 *2 hari lagi*";
    } else if (hw.daysDiff <= 3) {
      urgencyEmoji = "🟠 *3 hari lagi*";
    } else if (hw.daysDiff <= 5) {
      urgencyEmoji = "🟢 *5 hari lagi*";
    } else {
      urgencyEmoji = `⚪ *${hw.daysDiff} hari lagi*`;
    }

    msg += `*${i + 1}. ${hw.className}*\n`;
    msg += `> 📝 *Tugas:* ${hw.hw_name}\n`;
    msg += `> ⏰ *${hw.cleanDate}*\n`;
    msg += `> Sisa Waktu: ${urgencyEmoji}\n\n`;
  });

  msg += "━━━━━━━━━━━━━━━━━━━━━\n";
  msg += `Total: *${items.length}* tugas terdeteksi.\n`;

  return msg;
}

/**
 * Resolves the message text from payload object or file
 */
function formatFromPayload(data) {
  if (typeof data === "string") {
    return data;
  }
  if (!data) return DEFAULT_ALERT_MESSAGE;

  // If skipped (e.g., already ran today)
  if (data.status === "skipped") {
    console.log(
      "[alert.js] Notice: Fetcher reported that it already ran today.",
    );
    return null;
  }

  // If empty and SEND_ON_EMPTY is disabled
  if (data.count === 0 && !SEND_ON_EMPTY) {
    console.log(
      "[alert.js] No homework pending and SEND_ON_EMPTY is false. Skipping WhatsApp message.",
    );
    return null;
  }

  // If items list was provided, re-format using formatWhatsAppMessage so logic applies
  if (Array.isArray(data.items)) {
    return formatWhatsAppMessage(data.items);
  }

  // If pre-formatted whatsappMessage was provided
  if (data.whatsappMessage && typeof data.whatsappMessage === "string") {
    return data.whatsappMessage;
  }

  // Fallback to discordMessage or generic message
  if (data.discordMessage) {
    return data.discordMessage;
  }
  if (data.message) {
    return data.message;
  }

  return DEFAULT_ALERT_MESSAGE;
}

/**
 * Resolve the message string and items to send from command line arguments or default payload file
 */
function resolvePayload() {
  // 1. Argument passed via CLI: node alert.js <arg>
  if (process.argv[2]) {
    const arg = process.argv[2].trim();
    if (fs.existsSync(arg)) {
      try {
        const raw = fs.readFileSync(arg, "utf-8");
        const parsed = JSON.parse(raw);
        return {
          message: formatFromPayload(parsed),
          items: parsed.items || null,
        };
      } catch (e) {
        console.warn(
          "[alert.js] Could not parse argument as JSON file, treating as text:",
          e.message,
        );
      }
    }
    return { message: arg, items: null };
  }

  // 2. Default hw_payload.json file in current script directory
  const defaultPayloadPath = path.join(__dirname, "hw_payload.json");
  if (fs.existsSync(defaultPayloadPath)) {
    try {
      const raw = fs.readFileSync(defaultPayloadPath, "utf-8");
      const parsed = JSON.parse(raw);
      return {
        message: formatFromPayload(parsed),
        items: parsed.items || null,
      };
    } catch (e) {
      console.warn(
        "[alert.js] Failed parsing default hw_payload.json:",
        e.message,
      );
    }
  }

  // 3. Fallback
  return { message: DEFAULT_ALERT_MESSAGE, items: null };
}

/**
 * Finds the target JID for the "Reminder 🔔" Community Announcement channel ("Pengumuman")
 */
async function resolveTargetJid(sock) {
  try {
    const groups = await sock.groupFetchAllParticipating();

    // 1. Find community parent "Reminder 🔔"
    let parentCommunityId = null;
    for (const [id, g] of Object.entries(groups)) {
      if (
        (g.subject === TARGET_COMMUNITY_NAME ||
          g.subject?.includes("Reminder")) &&
        g.isCommunity
      ) {
        parentCommunityId = id;
        break;
      }
    }

    // 2. Look for the announcement group (Pengumuman / isCommunityAnnounce) linked to this community
    if (parentCommunityId) {
      for (const [id, g] of Object.entries(groups)) {
        if (
          g.linkedParent === parentCommunityId &&
          (g.isCommunityAnnounce ||
            g.announce ||
            g.subject?.toLowerCase().includes("pengumuman") ||
            g.subject === TARGET_COMMUNITY_NAME)
        ) {
          console.log(
            `[alert.js] Found community announcement group: "${g.subject}" (${id})`,
          );
          return id;
        }
      }
    }

    // 3. Check directly by explicit TARGET_GROUP_JID if in participating groups
    if (TARGET_GROUP_JID && groups[TARGET_GROUP_JID]) {
      console.log(
        `[alert.js] Using configured group JID: ${TARGET_GROUP_JID} ("${groups[TARGET_GROUP_JID].subject}")`,
      );
      return TARGET_GROUP_JID;
    }
  } catch (err) {
    console.warn(
      "[alert.js] Failed fetching groups dynamically, falling back to static config:",
      err.message,
    );
  }

  // 4. Default to KNOWN_TARGET_GROUP_JID or user phone
  if (TARGET_GROUP_JID) {
    return TARGET_GROUP_JID;
  }
  if (MY_PHONE_NUMBER) {
    return `${MY_PHONE_NUMBER.replace(/\D/g, "")}@s.whatsapp.net`;
  }
  return null;
}

async function sendSelfAlert(customMessage) {
  const resolved = resolvePayload();
  let messageToSend =
    customMessage !== undefined ? customMessage : resolved.message;

  if (!messageToSend) {
    console.log("[alert.js] Nothing to send to WhatsApp. Exiting.");
    process.exit(0);
  }

  console.log("[alert.js] Preparing WhatsApp alert...");
  console.log("----------------------------------------");
  console.log(messageToSend);
  console.log("----------------------------------------");

  const sessionPath = path.join(__dirname, "session_auth");
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: "error" }), // Show critical socket errors if they occur
    printQRInTerminal: false,
    // Emulates a standard desktop browser to avoid WhatsApp sync hangs
    browser: Browsers.macOS("Desktop"),
    syncFullHistory: false, // Prevents hanging while trying to fetch gigabytes of old chats
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  sock.ev.on("creds.update", saveCreds);

  // Track latest incoming message keys per chat to identify "message above"
  const latestChatMessages = {};
  const lastMsgFile = path.join(__dirname, ".last_alert_message.json");

  let savedLastKey = null;
  if (fs.existsSync(lastMsgFile)) {
    try {
      savedLastKey = JSON.parse(fs.readFileSync(lastMsgFile, "utf-8"));
    } catch (e) {
      console.warn("[alert.js] Could not parse last message file:", e.message);
    }
  }

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const m of messages) {
      if (m.key && m.key.remoteJid && m.message && !m.message.protocolMessage) {
        latestChatMessages[m.key.remoteJid] = m.key;
      }
    }
  });

  sock.ev.on("messaging-history.set", ({ messages }) => {
    for (const m of messages) {
      if (m.key && m.key.remoteJid && m.message && !m.message.protocolMessage) {
        latestChatMessages[m.key.remoteJid] = m.key;
      }
    }
  });

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("\nScan this QR code with WhatsApp:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "connecting") {
      console.log("[alert.js] Connecting to WhatsApp... Keep script running.");
    }

    if (connection === "open") {
      console.log("[alert.js] Successfully paired and connected!");

      const targetJid = await resolveTargetJid(sock);

      if (!targetJid) {
        console.error(
          "[alert.js] Error: Could not resolve target group or phone number JID!",
        );
        process.exit(1);
      }

      console.log(`[alert.js] Target JID: ${targetJid}`);

      // Small delay to allow any incoming sync packets / messages to be captured
      await new Promise((r) => setTimeout(r, 1500));

      // --- 1. DELETE MESSAGE ABOVE ---
      const deleteTargets = [];
      if (latestChatMessages[targetJid]) {
        deleteTargets.push(latestChatMessages[targetJid]);
      }
      if (
        savedLastKey &&
        (!latestChatMessages[targetJid] ||
          savedLastKey.id !== latestChatMessages[targetJid].id)
      ) {
        deleteTargets.push(savedLastKey);
      }

      for (const target of deleteTargets) {
        const msgId = target.id;
        const fromMe = Boolean(target.fromMe);
        console.log(
          `[alert.js] Attempting deletion of message above (ID: ${msgId}, fromMe: ${fromMe})...`,
        );

        // Attempt 1: Standard delete via sock.sendMessage
        let deleted = false;
        try {
          const deletePayload = {
            remoteJid: targetJid,
            id: msgId,
            fromMe: fromMe,
          };
          if (target.participant) {
            deletePayload.participant = target.participant;
          }
          await sock.sendMessage(targetJid, { delete: deletePayload });
          deleted = true;
          console.log(
            `[alert.js] Successfully sent revoke for message ${msgId}.`,
          );
        } catch (delErr) {
          console.warn(
            `[alert.js] sock.sendMessage delete failed: ${delErr.message}`,
          );
        }

        // Attempt 2: If fromMe was false or attempt 1 threw, try as admin revoke (edit: '8')
        if (!deleted && !fromMe && targetJid.endsWith("@g.us")) {
          try {
            await sock.sendMessage(targetJid, {
              delete: {
                remoteJid: targetJid,
                id: msgId,
                fromMe: false,
                participant: target.participant,
              },
            });
            deleted = true;
            console.log(`[alert.js] Admin revoke sent for message ${msgId}.`);
          } catch (delErr2) {
            console.warn(`[alert.js] Admin revoke failed: ${delErr2.message}`);
          }
        }

        // Attempt 3: Local chat clear via chatModify so message is cleared from chat view
        try {
          if (typeof sock.chatModify === "function") {
            await sock.chatModify(
              {
                clear: {
                  messages: [
                    {
                      id: msgId,
                      fromMe: fromMe,
                      timestamp:
                        target.messageTimestamp || Date.now().toString(),
                    },
                  ],
                },
              },
              targetJid,
            );
            console.log(`[alert.js] Chat view cleared for message ${msgId}.`);
          }
        } catch (clearErr) {
          // Non-critical if chatModify fails
        }

        await new Promise((r) => setTimeout(r, 800));
      }

      // --- 2. RETRIEVE PARTICIPANTS FOR @everyone MENTION ---
      // Requirement: Ping everyone when "Sisa waktu" is on 2 days left (daysDiff <= 2)
      // Account for DEBUG_DATE_OFFSET_DAYS during simulation debugging
      const shouldPingEveryone = Boolean(
        resolved.items &&
        resolved.items.some((hw) => {
          const effectiveDiff = DEBUG_DATE_OFFSET_DAYS
            ? Number(hw.daysDiff) - DEBUG_DATE_OFFSET_DAYS
            : Number(hw.daysDiff);
          return effectiveDiff <= 2;
        }),
      );

      const mentions = [];
      const participantTags = [];

      if (shouldPingEveryone && targetJid.endsWith("@g.us")) {
        console.log(
          "[alert.js] Task deadline is within 2 days! Preparing single mention for all members...",
        );
        try {
          // Load reverse LID-to-phone mapping cache if available
          let reverseLidCache = {};
          const cachePath = path.join(
            __dirname,
            "session_auth",
            "lid_reverse_cache.json",
          );
          if (fs.existsSync(cachePath)) {
            try {
              reverseLidCache = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
            } catch (e) {}
          }

          const rawParticipants = [];
          const meta = await sock.groupMetadata(targetJid);
          for (const p of meta.participants || []) {
            rawParticipants.push(p);
          }

          // If target group is community announcement group, also check parent community members
          const groups = await sock
            .groupFetchAllParticipating()
            .catch(() => ({}));
          const targetGroup = groups[targetJid];
          if (targetGroup?.linkedParent) {
            try {
              const parentMeta = await sock.groupMetadata(
                targetGroup.linkedParent,
              );
              for (const p of parentMeta.participants || []) {
                rawParticipants.push(p);
              }
            } catch (parentErr) {
              // Ignore parent fetch error
            }
          }

          // Identify our own bot numbers to avoid self-tagging
          const myPn = sock.user?.id
            ? sock.user.id.split("@")[0].split(":")[0]
            : null;
          const myLid = sock.user?.lid
            ? sock.user.lid.split("@")[0].split(":")[0]
            : null;

          // Deduplicate so each human member is represented only ONCE
          const seenUsers = new Set();
          if (myPn) seenUsers.add(myPn);
          if (myLid) seenUsers.add(myLid);

          for (const p of rawParticipants) {
            let uniqueId = null;
            let pnJid = null;

            if (p.phoneNumber) {
              const cleanPn = p.phoneNumber.replace(/\D/g, "");
              if (cleanPn) {
                uniqueId = cleanPn;
                pnJid = `${cleanPn}@s.whatsapp.net`;
              }
            }

            const idStr = p.id || "";
            const rawUser = idStr.split("@")[0].split(":")[0];

            if (!uniqueId) {
              if (idStr.endsWith("@s.whatsapp.net")) {
                uniqueId = rawUser;
                pnJid = `${rawUser}@s.whatsapp.net`;
              } else if (idStr.endsWith("@lid")) {
                if (reverseLidCache[rawUser]) {
                  uniqueId = reverseLidCache[rawUser];
                  pnJid = `${reverseLidCache[rawUser]}@s.whatsapp.net`;
                } else {
                  uniqueId = rawUser;
                  pnJid = `${rawUser}@lid`;
                }
              } else {
                uniqueId = rawUser;
                pnJid = idStr;
              }
            }

            if (!uniqueId || seenUsers.has(uniqueId)) {
              continue;
            }

            seenUsers.add(uniqueId);
            mentions.push(pnJid);
            participantTags.push(`@${uniqueId}`);
          }

          console.log(
            `[alert.js] Found ${participantTags.length} unique member(s) to ping (single mention each).`,
          );
        } catch (err) {
          console.warn(
            "[alert.js] Could not fetch group participants for mentions:",
            err.message,
          );
        }
      }

      // Format final message:
      // If deadline <= 2 days, append single list of tags so WhatsApp parses mentions without duplicates.
      // If deadline > 2 days, no member tags are appended.
      let finalMessage = messageToSend;
      if (participantTags.length > 0) {
        const tagTokensString = participantTags.join(" ");
        finalMessage = `${finalMessage}\n\n👥 ${tagTokensString}`;
      }

      // --- 3. SEND MESSAGE ---
      try {
        const sendOptions = { text: finalMessage };
        if (mentions.length > 0) {
          sendOptions.mentions = mentions;
        }

        console.log(`[alert.js] Sending alert to: ${targetJid}`);
        const sent = await sock.sendMessage(targetJid, sendOptions);

        if (sent && sent.key) {
          try {
            fs.writeFileSync(
              lastMsgFile,
              JSON.stringify(sent.key, null, 2),
              "utf-8",
            );
            console.log(
              "[alert.js] Saved sent message key for future deletion.",
            );
          } catch (saveErr) {
            console.warn(
              "[alert.js] Failed saving sent message key:",
              saveErr.message,
            );
          }
        }

        console.log(
          `[alert.js] Alert successfully posted to "${TARGET_COMMUNITY_NAME}" -> Pengumuman!`,
        );
      } catch (err) {
        console.error("[alert.js] Failed to send message:", err);
      } finally {
        // Wait 3 seconds to ensure the acknowledgment packet is exchanged
        setTimeout(() => {
          console.log("[alert.js] Done.");
          process.exit(0);
        }, 3000);
      }
    } else if (connection === "close") {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.log(
        `[alert.js] Connection closed (code: ${statusCode}). Reconnecting: ${shouldReconnect}`,
      );

      if (shouldReconnect) {
        // Reconnect to finish handshake if disconnected during pairing
        sendSelfAlert(messageToSend);
      } else {
        console.log(
          "[alert.js] Session was logged out. Delete ./session_auth and scan again.",
        );
        process.exit(1);
      }
    }
  });
}

// Execute if run directly
if (require.main === module) {
  sendSelfAlert();
}

module.exports = {
  sendSelfAlert,
  formatWhatsAppMessage,
  formatFromPayload,
};
