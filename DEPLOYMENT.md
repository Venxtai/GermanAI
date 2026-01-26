# Deployment Guide - Making the App Public

## Important Considerations for Public Deployment

### 1. Security & API Key Protection
⚠️ **CRITICAL**: With public access, you need to protect your OpenAI API key from abuse.

**Current Issue**: Your API key is server-side, which is good, but any student can use your app and consume your OpenAI credits.

**Solutions**:
- Implement user authentication (require login)
- Set usage limits per user
- Monitor API usage daily
- Consider requiring students to use their own API keys
- Implement rate limiting

### 2. Cost Management
With multiple students using the app simultaneously:
- **Estimate**: 100 students × 2 sessions/week × $0.50/session = **$100/week**
- Set strict OpenAI spending limits
- Consider implementing session time limits
- Monitor usage in real-time

### 3. HTTPS Requirement
Microphone access requires HTTPS (secure connection). All deployment options below provide this automatically.

---

## Deployment Options

### Option 1: Railway (Recommended - Easiest & Fast)

**Pros**: 
- Easy setup
- Free tier available ($5 credit/month)
- Automatic HTTPS
- GitHub integration
- Great for Node.js apps

**Steps**:

1. **Create a Railway Account**
   - Go to: https://railway.app/
   - Sign up with GitHub

2. **Prepare Your Code**
   ```powershell
   # Initialize git if not already done
   git init
   git add .
   git commit -m "Initial commit"
   
   # Push to GitHub
   # Create a new repository on GitHub first
   git remote add origin https://github.com/yourusername/voice-learning.git
   git branch -M main
   git push -u origin main
   ```

3. **Deploy on Railway**
   - Click "New Project" → "Deploy from GitHub repo"
   - Select your repository
   - Railway auto-detects Node.js and deploys

4. **Add Environment Variables**
   - In Railway dashboard → Variables
   - Add: `OPENAI_API_KEY=your-key-here`
   - Add: `PORT=3000`

5. **Get Your URL**
   - Railway provides a URL like: `https://your-app.up.railway.app`
   - Share this with students

**Cost**: Free tier ($5/month credit), then ~$5-20/month for hosting

---

### Option 2: Render

**Pros**:
- Free tier available
- Easy deployment
- Automatic HTTPS

**Steps**:

1. **Sign up**: https://render.com/

2. **Create Web Service**
   - New → Web Service
   - Connect your GitHub repository
   - Build Command: `npm install`
   - Start Command: `npm start`

3. **Environment Variables**
   - Add `OPENAI_API_KEY`

4. **Deploy**
   - Click "Create Web Service"
   - Get URL like: `https://your-app.onrender.com`

**Cost**: Free tier available, then $7/month for paid tier

---

### Option 3: Heroku

**Pros**:
- Well-established
- Good documentation
- Easy to scale

**Steps**:

1. **Install Heroku CLI**
   ```powershell
   # Download from: https://devcenter.heroku.com/articles/heroku-cli
   ```

2. **Create Heroku App**
   ```powershell
   heroku login
   heroku create your-app-name
   ```

3. **Add Procfile** (create this file in your project root):
   ```
   web: node server/server.js
   ```

4. **Set Environment Variables**
   ```powershell
   heroku config:set OPENAI_API_KEY=your-key-here
   ```

5. **Deploy**
   ```powershell
   git push heroku main
   ```

6. **Open App**
   ```powershell
   heroku open
   ```

**Cost**: Free tier discontinued, starts at $5/month

---

### Option 4: Vercel (Frontend Only - Requires Modification)

Vercel is great for frontend but requires converting the backend to serverless functions.

**Not recommended** for this project unless you're comfortable with serverless architecture.

---

### Option 5: DigitalOcean App Platform

**Pros**:
- More control
- Predictable pricing
- Professional grade

**Steps**:

1. **Sign up**: https://www.digitalocean.com/

2. **Create App**
   - Apps → Create App
   - Connect GitHub repo
   - Select Node.js
   - Add environment variables

3. **Deploy**
   - DigitalOcean handles the rest

**Cost**: Starts at $5/month

---

## Required Changes Before Deployment

### 1. Create a Procfile
Create `Procfile` (no extension) in project root:
```
web: node server/server.js
```

### 2. Update package.json
Ensure your `package.json` has the start script:
```json
{
  "scripts": {
    "start": "node server/server.js"
  },
  "engines": {
    "node": ">=16.0.0"
  }
}
```

### 3. Add .gitignore
Ensure these are in `.gitignore`:
```
node_modules/
.env
uploads/
*.log
```

### 4. Update CORS Settings (for production)
In `server/server.js`, update CORS:
```javascript
// Development: allow all origins
app.use(cors());

// Production: specify your domain
// app.use(cors({
//   origin: 'https://your-domain.com'
// }));
```

---

## Security Enhancements for Public Use

### 1. Add Rate Limiting

Install package:
```powershell
npm install express-rate-limit
```

Update `server/server.js`:
```javascript
const rateLimit = require('express-rate-limit');

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // limit each IP to 20 requests per windowMs
  message: 'Too many requests, please try again later.'
});

app.use('/api/', limiter);
```

### 2. Add Session Time Limits

Limit conversation length to prevent abuse:
```javascript
const MAX_CONVERSATION_TURNS = 20;
const MAX_CONVERSATION_TIME = 15 * 60 * 1000; // 15 minutes
```

### 3. Add User Authentication (Recommended)

Consider using:
- Auth0 (https://auth0.com/)
- Firebase Authentication
- Custom JWT authentication

### 4. Monitor Usage

Set up monitoring:
- Railway/Render/Heroku have built-in logging
- OpenAI Dashboard: https://platform.openai.com/usage
- Set up email alerts for high usage

---

## Step-by-Step: Deploy to Railway (Quickest)

1. **Push to GitHub**
   ```powershell
   git init
   git add .
   git commit -m "Initial commit"
   # Create repo on GitHub, then:
   git remote add origin https://github.com/yourusername/your-repo.git
   git push -u origin main
   ```

2. **Deploy to Railway**
   - Visit: https://railway.app/
   - Click "Start a New Project"
   - Choose "Deploy from GitHub repo"
   - Select your repository
   - Railway auto-deploys!

3. **Add Environment Variable**
   - Click on your deployment
   - Go to "Variables" tab
   - Add `OPENAI_API_KEY` with your key

4. **Generate Domain**
   - Go to "Settings"
   - Click "Generate Domain"
   - Get URL like: `https://voicemodel-production.up.railway.app`

5. **Share with Students**
   - Give them the URL
   - They can access it from any device

**Total Time**: ~10 minutes

---

## Cost Breakdown for Public Use

### Hosting Costs
- Railway: $5-20/month
- Render: $0-7/month
- Heroku: $5-25/month

### OpenAI API Costs (Most Important!)
- 50 students doing 2 sessions/week: ~$200/month
- 100 students: ~$400/month
- 200 students: ~$800/month

**Total**: Plan for $20-500+/month depending on usage

### Cost Reduction Strategies:
1. **Use GPT-3.5-Turbo** instead of GPT-4 (50% cheaper)
2. **Limit session length** to 10 minutes
3. **Require students to use their own API keys** (most cost-effective)
4. **Implement daily/weekly usage caps per user**

---

## Testing Before Going Public

1. **Test with HTTPS locally**:
   ```powershell
   # Use ngrok for local HTTPS testing
   npm install -g ngrok
   ngrok http 3000
   ```

2. **Load Testing**:
   - Use tools like Apache Bench or Artillery
   - Simulate multiple simultaneous users

3. **Security Testing**:
   - Check that .env is not accessible
   - Test rate limiting
   - Try API abuse scenarios

---

## Recommended Configuration for Exam Use

### For Oral Exams:
1. **Create unique access codes** for each exam session
2. **Time-limited access** (e.g., exam day only)
3. **Monitor active sessions** in real-time
4. **Automatic logout** after exam duration
5. **Record conversation logs** for grading (optional)

### Add Exam Mode:
- Disable unit selection (use assigned unit)
- Fixed conversation duration
- Automatic session end
- Submit button for completion

---

## Next Steps

1. Choose a deployment platform (Railway recommended)
2. Set up security measures (rate limiting minimum)
3. Deploy to production
4. Test with a small group first
5. Monitor costs for 1 week
6. Scale up for all students

Would you like me to help you deploy to a specific platform?
