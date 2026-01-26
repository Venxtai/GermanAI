# Setup Instructions - German Language Learning App

## Quick Start Guide (5 Minutes)

Follow these steps to get the application running:

### Step 1: Install Node.js
If not already installed:
1. Download from: https://nodejs.org/ (LTS version recommended)
2. Run the installer
3. Verify installation:
   ```powershell
   node --version
   npm --version
   ```

### Step 2: Install Dependencies
Open PowerShell in the project directory and run:
```powershell
npm install
```

This will install:
- express (web server)
- openai (API client)
- cors (cross-origin requests)
- dotenv (environment variables)
- multer (file uploads)
- form-data (multipart form data)

### Step 3: Get OpenAI API Key

1. **Create OpenAI Account**
   - Go to: https://platform.openai.com/signup
   - Sign up with email or Google

2. **Add Payment Method**
   - Navigate to: https://platform.openai.com/account/billing
   - Add a credit card
   - Add initial credits (minimum $5 recommended)

3. **Set Usage Limit** (IMPORTANT!)
   - Go to: Billing → Usage limits
   - Set a monthly limit (e.g., $20) to prevent unexpected charges

4. **Generate API Key**
   - Go to: https://platform.openai.com/api-keys
   - Click "Create new secret key"
   - Name it (e.g., "German Learning App")
   - **Copy the key** (you won't see it again!)
   - Format: `sk-proj-...`

### Step 4: Configure Environment Variables

1. **Create .env file**
   ```powershell
   Copy-Item .env.example .env
   ```

2. **Edit .env file**
   Open `.env` in a text editor and replace the placeholder:
   ```
   OPENAI_API_KEY=sk-proj-your-actual-key-here
   PORT=3000
   NODE_ENV=development
   ```

   ⚠️ **CRITICAL**: Never commit `.env` to version control!

### Step 5: Create Uploads Directory
```powershell
New-Item -ItemType Directory -Force -Path uploads
```

### Step 6: Start the Server

**Option A: Development Mode** (auto-restart on changes)
```powershell
npm run dev
```

**Option B: Production Mode**
```powershell
npm start
```

You should see:
```
Server running on http://localhost:3000
Curriculum data loaded: 5 units
```

### Step 7: Open the Application

Open your web browser and navigate to:
```
http://localhost:3000
```

You should see the unit selection page!

## Testing the Application

### Test 1: Unit Selection
1. Enter a unit number (1-5)
2. Verify that unit information loads
3. Click "Gespräch beginnen"

### Test 2: Speech Input
1. Allow microphone access when prompted
2. Hold the green "Halten zum Sprechen" button
3. Say something in German (e.g., "Hallo, wie geht es dir?")
4. Release the button
5. Wait for transcription and AI response

### Test 3: Full Conversation
1. Start a conversation in Unit 1
2. Have a 3-5 turn conversation
3. Verify AI uses only Unit 1 vocabulary
4. End the conversation

## Troubleshooting

### Problem: "Cannot find module 'xyz'"
**Solution**: Run `npm install` again

### Problem: "OpenAI API key is invalid"
**Solution**: 
1. Verify the key in `.env` is correct
2. Check for extra spaces or quotes
3. Ensure the key starts with `sk-`
4. Verify you have billing set up on OpenAI

### Problem: "Port 3000 is already in use"
**Solution**:
1. Change PORT in `.env` to 3001 or another number
2. Or stop the process using port 3000:
   ```powershell
   Get-Process -Id (Get-NetTCPConnection -LocalPort 3000).OwningProcess | Stop-Process
   ```

### Problem: "Microphone not working"
**Solution**:
1. Check browser permissions (usually icon in address bar)
2. Try a different browser (Chrome recommended)
3. Verify microphone works in other apps
4. For production, ensure HTTPS is used

### Problem: "No curriculum data loaded"
**Solution**:
1. Verify `curriculum/units.json` exists
2. Check JSON syntax using: https://jsonlint.com/
3. Restart the server

### Problem: "Audio playback doesn't work"
**Solution**:
1. Check browser console for errors (F12)
2. Verify audio is not muted
3. Try a different browser

## Development Workflow

### Adding New Units
1. Edit `curriculum/units.json`
2. Add new unit objects following the schema
3. Restart the server
4. Test the new unit

### Modifying AI Behavior
1. Edit `server/server.js`
2. Find `generateSystemPrompt()` function
3. Modify the prompt template
4. Restart server (automatic with `npm run dev`)

### Changing UI
1. Edit files in `public/` directory
2. Refresh browser (no server restart needed)

## Production Deployment Checklist

Before deploying to a production server:

- [ ] Set `NODE_ENV=production` in `.env`
- [ ] Use a process manager (PM2, Forever)
- [ ] Set up HTTPS/SSL certificates
- [ ] Configure firewall rules
- [ ] Set up database for persistent storage
- [ ] Implement user authentication
- [ ] Add rate limiting
- [ ] Set up error logging and monitoring
- [ ] Configure backups
- [ ] Add usage analytics

### Recommended Production Stack
- **Hosting**: Heroku, AWS, DigitalOcean, or Azure
- **Database**: MongoDB Atlas (for conversations)
- **Process Manager**: PM2
- **Reverse Proxy**: Nginx
- **SSL**: Let's Encrypt

## Cost Estimation

### Per Conversation (10 minutes)
- Speech-to-Text: ~$0.06 (10 min × $0.006/min)
- Text-to-Speech: ~$0.15 (10 responses × 100 chars × $0.015/1000)
- GPT-4: ~$0.30 (10 exchanges × 300 tokens × $0.03/1000)
- **Total: ~$0.50 per 10-minute conversation**

### Monthly Cost Examples
- 10 students, 2 sessions/week: ~$40/month
- 50 students, 2 sessions/week: ~$200/month
- 100 students, 2 sessions/week: ~$400/month

**Cost Reduction Strategies**:
1. Use `gpt-3.5-turbo` instead of `gpt-4` (50% cheaper)
2. Limit conversation length
3. Cache common responses
4. Use lower quality TTS model for less critical parts

## Security Best Practices

### ✅ DO:
- Keep `.env` file secret
- Set OpenAI spending limits
- Use environment variables for all secrets
- Regularly update dependencies
- Monitor API usage

### ❌ DON'T:
- Commit `.env` to git
- Share API keys publicly
- Expose API keys in frontend code
- Use the same API key for development and production
- Ignore security warnings

## Support & Resources

### Documentation
- OpenAI API Docs: https://platform.openai.com/docs
- Express.js Guide: https://expressjs.com/
- Node.js Docs: https://nodejs.org/docs

### Getting Help
1. Check the "Bekannte Probleme" section in README.md
2. Review server logs in the terminal
3. Check browser console (F12 → Console)
4. Review OpenAI API status: https://status.openai.com/

## Next Steps

After successful setup:
1. **Professor**: Provide curriculum materials (Word docs, vocabulary lists)
2. **Developer**: Convert units 6-104 to JSON format
3. **Both**: Test conversations at different unit levels
4. **Both**: Refine AI prompts based on testing
5. **Developer**: Implement additional features (user accounts, progress tracking, etc.)

---

**Setup Complete!** 🎉

The application is now ready for initial testing. Proceed to the README.md for usage instructions.
