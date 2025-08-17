
# Node JS Discord Music Bot Setup

This guide walks you through installing the necessary packages to run a high-performance Discord music bot using Node.js.

---

## 📦 Installation

Run the following commands in your bot's root directory:

### Core Dependencies

npm install discord.js @discordjs/voice play-dl(tested)
npm install @discordjs/opus(tested)
# OR
npm install opusscript(Not tested)

# And for better performance:
npm install sodium-native
# OR
npm install tweetnacl (not tested)


Correct file structure:
discord-music-bot/
│
├── node_modules/       ← Never create or edit files here
│   └── (all the installed packages)
│
├── index.js           ← CREATE YOUR FILE HERE
├── package.json       ← Your package.json is here
└── package-lock.json  ← Auto-generated file

These are steps certified to be MAGA proof
A cretin would not comprehend computer science
