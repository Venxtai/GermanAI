# German Conversation Buddy

An AI-powered German conversation practice tool. A 3D teacher character speaks with students in German, adapting vocabulary and topics to their current unit in *Impuls Deutsch 1* or *Impuls Deutsch 2*.

---

## What you need before starting

1. **Node.js** (version 20 or higher)
   - Download from: https://nodejs.org — click the "LTS" button and install it
   - After installing, open a terminal and type `node --version` to confirm it worked

2. **An OpenAI API key**
   - Go to https://platform.openai.com/api-keys and create an account if you don't have one
   - Click **"Create new secret key"**, copy the key (starts with `sk-`)
   - You will need a funded account — the app uses the **Realtime API** (approximately $0.05–$0.15 per conversation)

3. **A microphone** connected to your computer

---

## Setup (one time only)

Open a terminal in the project folder and follow these steps in order.

### Step 1 — Create your API key file

Copy the example file and add your key:

**Mac / Linux:**
```bash
cp .env.example .env
```

**Windows (PowerShell):**
```powershell
Copy-Item .env.example .env
```

Then open the `.env` file with any text editor (Notepad is fine) and replace `your_openai_api_key_here` with your actual key:

```
OPENAI_API_KEY=sk-...your key here...
PORT=3000
NODE_ENV=development
```

> **Keep this file private.** It is already excluded from git and will never be pushed to GitHub.

### Step 2 — Install server dependencies

```bash
npm install
```

### Step 3 — Install frontend dependencies

```bash
cd frontend
npm install
cd ..
```

---

## Running the app

You need **two terminal windows** open at the same time, both in the project folder.

**Terminal 1 — Start the backend server:**
```bash
node server/server.js
```
You should see: `Server running on http://localhost:3000`

**Terminal 2 — Start the frontend:**
```bash
cd frontend
npm run dev
```
You should see: `Local: http://localhost:5173`

Then open **http://localhost:5173** in your browser (Chrome or Edge recommended).

---

## Using the app

1. Select your textbook (*Impuls Deutsch 1*, *2 Blau*, or *2 Orange*)
2. Select the chapter, then choose the last unit you covered in class
3. Read the welcome screen and click **Start Conversation**
4. Wait for the AI teacher to greet you in German
5. **Hold the microphone button** while you speak, then **release** to send your response
6. The teacher will reply in German — answer back and keep the conversation going!

### Tips
- Speak clearly and in German
- If you don't understand, say **"Wie bitte?"** or **"Noch einmal, bitte."**
- To see a live transcript of the conversation, click the **📋 Log** button during a session
- Click **End Session** when you're done

---

## Project structure

```
VoiceModel/
├── server/
│   └── server.js          # Backend — handles OpenAI auth tokens and API routes
├── frontend/
│   └── src/
│       ├── components/    # 3D scene, character, classroom, UI
│       ├── hooks/         # Voice connection and recording logic
│       └── utils/         # AI system instructions
├── curriculum/
│   └── units/
│       └── Knowledge Base/  # Unit data files (vocabulary, grammar, topics)
├── .env.example           # Template — copy to .env and add your API key
└── README.md
```

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Failed to connect" on session start | Make sure the backend server (Terminal 1) is running |
| No sound from the AI | Check your browser's audio permissions; try Chrome or Edge |
| Mic button does nothing | Allow microphone access when the browser asks; check browser mic permissions |
| "Audio not captured" error | Hold the button for at least half a second before releasing |
| Port already in use | Another instance is running — close it or restart your terminal |
