# College ELearning Homework Stealer

This is a script I made in order to scrape my College eLearning website, gets all Due Homework, send it to my Webhook.

# How It Works

It works like below, note that the mindmap below are just a simplification, the actual script is a bit complex.

```
# Class_Fetcher.js
URL_LINK/class-list
|
segment:get_all_class
|
segment:send_to_session_storage_all_tracked_class
|
segment:run_hw_fetcher

# HW_Fetcher.js
segment:get_all_class_from_db = class_list
|
segment:for_each(class_list) => {
fn:get_deadline
|
fn:save_to_message_collection
}
if finish => send_message_to_discord
```

# Installation

1. Ensure you have TamperMonkey installed, get it on ChromeExtension
2. On Extension settings, go to Tampermonkey Config, and set "Allowed UserScript" as True.
<img width="685" height="92" alt="image" src="https://github.com/user-attachments/assets/b5e94b75-98e1-463a-b943-1d11a0205e43" />

4. On TamperMonkey, go to `Config` and then open InstalledUserscripts
5. Click the `+` button right beside the current tab.
6. Copy and Paste the `Class_Fetcher.js` and Save
7. Do the same at number 3, but now copy and paste for `HW_Fetcher.js`
8. Go to the elearning college website
9. Wait and let it do it's own process

# Constraint

1. This script requires you to open the elearning directly. But if you're a lazy-fuck like I do, and wanted this automated even when you do not open it directly. Then you can use `src/automate.py`

# Purpose

Sometimes tracking each lecturer due task is tiring. I made this script for convenience sake in order to always know what task is due. That's all.

# QNA

1. Is it illegal?
   > Technically, no. You are acting as user agent, you have your own agent-header, and you accessed it by your own account, even Cloudflare let you in. What the script does, it simply to automate the 'act' of getting the deadlines. After all, we did not bypass Cloudflare verification. So it's not a replacement or automaton, it is in regards to the User intent.
2. How to use this?
   > Either you forget to read, or you cannot read. Again, this script is reserved for my fellow colleagues to use. In order to track their task deadlines easily. It is **NOT** reserved for others.
3. It seems I cannot accessed the content or the DOM, due to CSP regulation, how do I prevent this>
   > Go to ChromeExtension, and install CSP blocker. And disable it for this college elearning website. I personally used "Disable Content-Security-Policy" extension.
4. You leaked your Webhook link, can I spam furry_sex in it?
   > Go on.
