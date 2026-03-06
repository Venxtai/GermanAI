# VoiceModel — Local Setup Guide

This guide walks you through setting up and running the **VoiceModel** German AI conversation practice application on your own computer from scratch. No prior programming experience with these tools is required — every step is explained in full detail.

---

## Overview of What You Are Running

The application has **two parts** that both need to be running at the same time:

| Part | What it does | Where you open it |
|---|---|---|
| **Backend (server)** | Handles OpenAI API calls, loads curriculum, generates personas | Runs silently in a terminal |
| **Frontend (UI)** | The visual interface you interact with in the browser | `http://localhost:5173` |

---

## Step 1 — Install Git

Git is needed to download (clone) the project.

1. Go to **https://git-scm.com/downloads**
2. Click **Windows** → download the installer
3. Run the installer — accept all defaults and click **Next** through every screen
4. When done, open the **Start Menu**, search for **"Git Bash"** and open it to confirm it installed

> **Already have Git?** Open **Command Prompt** (Start → search "cmd") and type `git --version`. If you see a version number, skip this step.

---

## Step 2 — Install Node.js

Node.js is the runtime that powers the server and frontend build tools.

1. Go to **https://nodejs.org**
2. Download the **LTS** version (the button on the left — it says "Recommended For Most Users")
3. Run the installer — accept all defaults
4. When done, open **Command Prompt** (Start → search "cmd") and verify:

```
node --version
npm --version
```

Both should print version numbers (e.g. `v22.x.x` and `10.x.x`). If they do, Node.js is ready.

---

## Step 3 — Install Visual Studio Code

1. Go to **https://code.visualstudio.com**
2. Click **Download for Windows**
3. Run the installer — on the **"Select Additional Tasks"** screen, check:
   - ✅ Add "Open with Code" action to Windows Explorer file context menu
   - ✅ Add to PATH (important — allows opening VS Code from the terminal)
4. Finish the installation and open VS Code

---

## Step 4 — Get Your OpenAI API Key

The application uses OpenAI's API (GPT-4o Realtime) to power the AI conversation partner. You need your own API key.

1. Go to **https://platform.openai.com/api-keys**
2. Sign in (or create an account if you don't have one)
3. Click **"Create new secret key"**
4. Give it a name (e.g. `VoiceModel`) and click **Create**
5. **Copy the key immediately** — it starts with `sk-...` and is only shown once. Paste it somewhere safe (e.g. Notepad) before closing this window.

> **Important:** OpenAI API usage incurs charges. The GPT-4o Realtime model is used for voice — make sure your OpenAI account has a payment method and sufficient credits. Each conversation session costs approximately $0.05–$0.30 depending on duration.

---

## Step 5 — Download the Project

1. Open **Command Prompt** (Start → search "cmd")
2. Navigate to where you want to store the project, e.g.:
   ```
   cd C:\Users\YourName\Desktop
   ```
3. Clone the repository (ask the student for their exact GitHub URL if you don't have it):
   ```
   git clone https://github.com/STUDENT-USERNAME/VoiceModel.git
   ```
   This will create a `VoiceModel` folder on your Desktop.
4. Enter the project folder:
   ```
   cd VoiceModel
   ```
5. Switch to your dedicated branch:
   ```
   git checkout ProfBranch
   ```
   You should see: `Switched to branch 'ProfBranch'`. All your changes will stay on this branch, separate from the main codebase.

---

## Step 6 — Open the Project in VS Code

1. In VS Code, go to **File → Open Folder…**
2. Browse to and select the `VoiceModel` folder
3. Click **Select Folder**

You will now see all project files listed in the left sidebar.

---

## Step 7 — Create the Environment File

The server needs your API key stored in a special file called `.env`. This file is **never shared** (it is excluded from version control for security).

1. In VS Code, look at the left sidebar (the **Explorer** panel)
2. You will see a file called `.env.example` — this is the template
3. Right-click on `.env.example` and choose **Copy**
4. Right-click in an empty area of the Explorer panel and choose **Paste**
5. Rename the pasted file from `.env.example (copy)` to exactly `.env` (no extension, just `.env`)

   > Alternatively: In the **Explorer** panel, click the **New File** icon (the page with a + icon at the top of the sidebar) and type `.env`

6. Open the `.env` file — you will see:
   ```
   OPENAI_API_KEY=your_openai_api_key_here
   PORT=3000
   NODE_ENV=development
   ```

7. Replace `your_openai_api_key_here` with the actual key you copied in Step 4:
   ```
   OPENAI_API_KEY=sk-proj-xxxxxxxxxxxxxxxxxxxxxxxx
   PORT=3000
   NODE_ENV=development
   ```

8. Save the file (**Ctrl+S**)

---

## Step 8 — Install Backend Dependencies

The backend server needs its libraries installed first.

1. In VS Code, open a terminal: **Terminal → New Terminal** (or press **Ctrl+`**)
2. The terminal opens at the bottom of the screen, already inside the `VoiceModel` folder
3. Run:
   ```
   npm install
   ```
4. Wait for it to finish — you will see a line like `added 83 packages` when done

---

## Step 9 — Install Frontend Dependencies

The frontend (React UI) has its own separate set of libraries.

1. In the **same terminal**, navigate into the frontend folder:
   ```
   cd frontend
   ```
2. Run:
   ```
   npm install
   ```
3. Wait for it to finish — this may take 1–2 minutes as it downloads many packages
4. Navigate back to the root folder when done:
   ```
   cd ..
   ```

---

## Step 10 — Start the Backend Server

You need **two terminals running at the same time** — one for the backend, one for the frontend.

1. In your current terminal (at the `VoiceModel` root), run:
   ```
   node server/server.js
   ```
2. You should see output like:
   ```
   Persona database loaded: 12 chapters
   Server running on http://localhost:3000
   ```

**Leave this terminal running.** Do not close it.

---

## Step 11 — Start the Frontend Dev Server

1. Open a **second terminal** in VS Code: click the **+** icon in the terminal panel (top right of the terminal area), or go to **Terminal → New Terminal**
2. Navigate to the frontend folder:
   ```
   cd frontend
   ```
3. Run:
   ```
   npm run dev
   ```
4. You should see output like:
   ```
   VITE v7.x.x  ready in 538 ms
   ➜  Local:   http://localhost:5173/
   ```

**Leave this terminal running too.**

---

## Step 12 — Open the App

1. Open any web browser (Chrome or Edge recommended)
2. Go to: **http://localhost:5173**
3. The VoiceModel app should load and be ready to use

---

## Stopping the Application

To stop both servers, click into each terminal and press **Ctrl+C**. You can then close VS Code.

---

## Starting the Application Again (Next Time)

Every time you want to run the app again, you only need to repeat **Steps 10 and 11** — the dependencies are already installed and the `.env` file is already set up.

Quick summary for next time:
1. Open VS Code → open the `VoiceModel` folder
2. Open Terminal 1: `node server/server.js`
3. Open Terminal 2: `cd frontend` then `npm run dev`
4. Open browser to `http://localhost:5173`

### Saving your changes back to GitHub

After editing files (e.g. the system prompt), you can save your work to `ProfBranch` so it isn't lost:

1. Open a terminal in VS Code (**Terminal → New Terminal**)
2. Check what you changed:
   ```
   git status
   ```
3. Stage all changes:
   ```
   git add .
   ```
4. Commit with a short description of what you did:
   ```
   git commit -m "Adjusted system prompt rules"
   ```
5. Push to GitHub:
   ```
   git push origin ProfBranch
   ```

---

## Troubleshooting

### "node is not recognized as a command"
Node.js is not installed or not on your PATH. Redo Step 2, and when installing, make sure the option **"Add to PATH"** is checked.

### "Cannot find module" errors when starting the server
Dependencies are not installed. Run `npm install` in the `VoiceModel` root folder (Step 8).

### The page loads but the AI doesn't respond / you see an API error
- Check that your `.env` file exists in the `VoiceModel` root folder (not inside `frontend/` or `server/`)
- Verify the API key in `.env` starts with `sk-` and has no extra spaces
- Check your OpenAI account at https://platform.openai.com — confirm it has a balance and the key is active

### Port 3000 is already in use
Another program is using that port. Either close the other program, or change `PORT=3001` in your `.env` file.

### The frontend loads but shows a blank/broken screen
Make sure the **backend** server (Step 10) is also running — the frontend depends on it.

---

## Navigating & Editing the System Prompt

All AI behavior is controlled by a single file. You do not need to understand the rest of the codebase — just this one file.

### Finding the file

In VS Code, use the left sidebar (**Explorer** panel) and navigate to:

```
frontend/
  src/
    utils/
      systemInstructions.js     ← THIS IS THE FILE
```

Click it to open. The file is long (~430 lines) but is divided into clearly labelled sections.

---

### What each section controls

The prompt sent to the AI is assembled from 10 numbered sections. Here is what each one does and where to find it in the file:

| Section | What it controls | Where to edit |
|---|---|---|
| **SECTION 1 — BEHAVIORAL INSTRUCTIONS** | How the AI talks, conversation phases, follow-up rules, error handling, absolute rules | Lines ~175–330 in the file |
| **SECTION 2 — PERSONA** | The AI's name, age, hometown, personality, hobbies, job — randomly generated each session from the database | Edit `server/personaDatabase.json` (see below) |
| **SECTION 3 — GRAMMAR CONSTRAINTS** | Which tenses, cases and sentence types are allowed/forbidden at each unit level | Comes from the curriculum unit JSON files, not edited here |
| **SECTION 4 — CONVERSATION TOPICS** | What topics the AI should bring up in this session | Comes from curriculum unit JSON files |
| **SECTION 5 — ACTIVE VOCABULARY** | Words the AI is allowed to use | Comes from curriculum unit JSON files |
| **SECTION 6 — PASSIVE VOCABULARY** | Extra words the student recognises but may not produce | Comes from curriculum unit JSON files |
| **SECTION 7 — UNIVERSAL FILLERS** | Filler phrases ("Ja", "Super!", etc.) always available | Edit the `fillerLines` block around line ~85 in `systemInstructions.js` |
| **SECTION 8 — MODEL SENTENCES** | Example sentences used as inspiration for phrasing | Comes from curriculum unit JSON files |
| **SECTION 9 — DURATION PARAMETERS** | Min/max conversation time per chapter | Edit `getDurations()` function at the very top of `systemInstructions.js` |
| **SECTION 10 — COMMUNICATIVE FUNCTIONS** | What language tasks the student is practicing | Comes from curriculum unit JSON files |

---

### The parts you will most likely want to edit

#### A — The AI's conversational rules and tone (Section 1)

This is the most impactful area to experiment with. Open `systemInstructions.js` and scroll to the line that reads:

```
SECTION 1 — BEHAVIORAL INSTRUCTIONS
```

Key blocks you can tweak:

- **CONVERSATION PHASES** — Adjust how the AI warms up, what it focuses on in the main conversation, and how it closes.
- **HOW TO TALK** — Change the strictness of the "one sentence per turn" rule, or how the AI reacts vs. asks questions.
- **IMPORTANT RULE — ALWAYS FOLLOW UP** — The rule requiring the AI to echo the student's exact word in its follow-up. You can soften or harden this.
- **ABSOLUTE RULES** — 9 numbered non-negotiable rules at the bottom of Section 1. Only change these carefully.
- **THE CAFÉ TEST** — The guidelines for what makes a good vs. bad question.

To edit: change the text inside the backtick template string. Save the file (**Ctrl+S**). Changes take effect on the next conversation session — no server restart needed.

#### B — The AI's fallback persona (Section 2)

If persona generation fails (no internet, API error), the AI falls back to a hardcoded persona near line ~158:

```js
personaSection = `Your name is Max. You are 22 years old and study Informatik...
```

You can edit this text directly.

#### C — The AI's randomly generated persona traits

Each session the server randomly picks one value per trait from `server/personaDatabase.json`. To change the pool of names, jobs, hobbies, etc.:

1. In VS Code Explorer, open `server/personaDatabase.json`
2. The file is organised by chapter key (e.g. `ID1_Ch1`, `ID1_Ch7`, etc.)
3. Each trait is an array of 5 options — the server picks one at random each session
4. Example — to change the available names for Chapter 1:
   ```json
   "Vorname": ["Max", "Felix", "Lukas", "Jonas", "Tim"]
   ```
   Edit the names inside the square brackets.
5. Save the file and **restart the backend server** (stop it with Ctrl+C in Terminal 1, then run `node server/server.js` again) for changes to take effect.

#### D — Conversation duration targets

At the very top of `systemInstructions.js` (around line 7) there is a function called `getDurations`. It maps each chapter to a minimum and maximum conversation time:

```js
const table = { 1:[3,5], 2:[4,7], 3:[4,7], ... }
//              ^ chapter  ^min   ^max  (all in minutes)
```

Change the numbers in the array to adjust targets. Save — no restart needed.

---

### How to save and test a change

1. Edit the file in VS Code
2. Press **Ctrl+S** to save
3. Go to the browser at `http://localhost:5173`
4. Select a unit and start a new conversation — the updated prompt is used immediately
5. To verify what prompt was sent, check the browser's **Developer Tools**: press **F12** → **Console** tab — the system instructions are logged there

---

## Project Structure (for reference)

```
VoiceModel/
├── .env                  ← Your API key (you create this — never share it)
├── .env.example          ← Template for the .env file
├── server/
│   ├── server.js         ← Backend Express server
│   └── personaDatabase.json  ← AI conversation partner trait data
├── frontend/
│   ├── src/              ← React UI source code
│   └── package.json      ← Frontend dependencies
├── curriculum/           ← German lesson units (JSON)
└── package.json          ← Backend dependencies
```
