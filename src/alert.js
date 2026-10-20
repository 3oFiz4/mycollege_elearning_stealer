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
const SEND_ON_EMPTY = false;

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

  const todayStr = new Date().toLocaleDateString("id-ID", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });

  const hasUrgent = items.some((hw) => Number(hw.daysDiff) <= 1);
  const tagHeader = hasUrgent
    ? "@everyone 🚨 *PERINGATAN DEADLINE DEKAT!* 🚨\n\n"
    : "";

  let msg = tagHeader;
  msg += "eLEARNING HOMEWORK REMINDER \n";
  msg += `${todayStr}\n`;
  msg += "━━━━━━━━━━━━━━━━━━━━━\n\n";

  items.forEach((hw, i) => {
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
  msg += "_Notifikasi otomatis dikirim via E-Learning Stealer_";

  return msg;
}

/**
 * Resolves the message text from payload object or file
 */
function formatFromPayload(data) {
  if (typeof data === "string") return data;
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

  // If items list was provided, re-format using formatWhatsAppMessage so @everyone logic applies
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
  const messageToSend =
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

      console.log(`[alert.js] Sending alert to: ${targetJid}`);

      // Check if message mentions @everyone or has items due in <= 1 day
      const mentions = [];
      const hasUrgent =
        (resolved.items &&
          resolved.items.some((hw) => Number(hw.daysDiff) <= 1)) ||
        messageToSend.includes("@everyone");

      if (hasUrgent && targetJid.endsWith("@g.us")) {
        try {
          const meta = await sock.groupMetadata(targetJid);
          for (const p of meta.participants || []) {
            if (p.id) mentions.push(p.id);
            if (p.phoneNumber && !mentions.includes(p.phoneNumber)) {
              mentions.push(p.phoneNumber);
            }
          }
          console.log(
            `[alert.js] Urgent deadline detected (<= 1 day left)! Tagging ${mentions.length} participant(s) via @everyone.`,
          );
        } catch (err) {
          console.warn(
            "[alert.js] Could not fetch group participants for mentions:",
            err.message,
          );
        }
      }

      try {
        const sendOptions = { text: messageToSend };
        if (mentions.length > 0) {
          sendOptions.mentions = mentions;
        }

        await sock.sendMessage(targetJid, sendOptions);
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
