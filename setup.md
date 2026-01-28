# Trigger.dev Setup Guide

This guide will help you set up the Trigger.dev worker for background email campaign processing.

## Prerequisites

- Node.js 16.x or higher
- npm or yarn package manager
- Trigger.dev account ([sign up here](https://trigger.dev))
- Backend API running (see backend/setup.md)
- Google OAuth credentials (same as backend)

## Installation Steps

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Edit `.env` with your actual values:
- Trigger.dev API key and project ID
- Google OAuth credentials
- Backend API URL

### 3. Get Trigger.dev Credentials

1. Go to [Trigger.dev](https://trigger.dev)
2. Sign up or log in
3. Create a new project
4. Copy your Project ID and Secret Key from the project settings
5. Add them to `.env`

### 4. Update Trigger Configuration

Edit `trigger.config.mjs` and replace the project ID with your actual Trigger.dev project ID:

```javascript
export default defineConfig({
    project: "proj_your_actual_project_id", // Replace this
    // ... rest of config
});
```

### 5. Verify Setup

Run the test script to verify everything is configured correctly:

```bash
npm run build
```

This will compile TypeScript and check for any configuration errors.

## Running the Worker

### Development Mode

```bash
npm run dev
```

This will:
- Start the Trigger.dev development server
- Watch for file changes
- Allow you to test tasks locally
- Connect to Trigger.dev cloud for task execution

### Production Deployment

```bash
npm run deploy
```

This will:
- Build your TypeScript code
- Upload tasks to Trigger.dev
- Make them available for production use

## Project Structure

```
trigger/
├── src/
│   ├── trigger/          # Trigger.dev task definitions
│   │   ├── emailCampaign.ts    # Main email campaign task
│   │   └── replyChecker.ts     # Email reply checker task
│   ├── agents/           # AI agent implementations
│   │   └── replyAgent.ts # AI reply generation agent
│   ├── utils/            # Utility functions
│   │   ├── tokenRefresh.ts     # OAuth token refresh
│   │   └── gmailSender.ts      # Gmail API client
│   └── test.ts           # Test script
├── trigger.config.mjs    # Trigger.dev configuration
├── tsconfig.json         # TypeScript configuration
├── package.json          # Dependencies
└── .env                  # Environment variables (not in git)
```

## How It Works

### Email Campaign Task

When a campaign is created in the backend:

1. Backend triggers the `sendEmailCampaign` task
2. Task receives campaign details, OAuth tokens, and contact information
3. Worker processes emails in batches:
   - Checks and refreshes OAuth tokens if needed
   - Fetches contacts from backend
   - Loads email template
   - Personalizes emails with contact data
   - Sends emails via Gmail API
   - Updates progress to backend
4. Task completes and updates final campaign status

### Reply Checker Task

Periodically checks for email replies:

1. Fetches users with active campaigns
2. Checks Gmail for new replies
3. Uses AI agent to generate appropriate responses
4. Sends replies and updates conversation history

## Task Configuration

### Email Campaign Task

- **Batch Size**: 10 emails per batch
- **Batch Delay**: 2 seconds between batches
- **Max Duration**: 60 seconds (configurable)
- **Retries**: 3 attempts with exponential backoff

### Token Refresh

The worker automatically:
- Checks token expiry before each batch
- Refreshes tokens if expiring within 5 minutes
- Updates tokens in backend database
- Handles refresh failures gracefully

## Testing

### Test Locally

1. Start backend API
2. Start Trigger.dev dev server: `npm run dev`
3. Create a campaign in the frontend
4. Monitor task execution in Trigger.dev dashboard

### Test Payload Example

```json
{
  "campaignId": "test-campaign-123",
  "userId": "user-123",
  "csvSource": "test.csv",
  "templateId": "template-123",
  "accessToken": "ya29.a0...",
  "refreshToken": "1//0g...",
  "tokenExpiry": "2025-11-24T23:00:00Z",
  "backendUrl": "http://localhost:8000"
}
```

## Monitoring

### Trigger.dev Dashboard

Monitor your tasks in the Trigger.dev dashboard:

1. View running tasks
2. Check logs and errors
3. See execution history
4. Monitor performance metrics

### Logs

- Task logs appear in Trigger.dev dashboard
- Backend receives progress updates via webhooks
- Check backend logs for webhook processing

## Troubleshooting

### Task Not Triggering

- Verify `TRIGGER_SECRET_KEY` is correct in backend `.env`
- Check backend can reach Trigger.dev API
- Verify project ID matches in `trigger.config.mjs`
- Check Trigger.dev dashboard for errors

### Token Refresh Failing

- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` are correct
- Ensure refresh token is valid
- Check that OAuth consent screen is configured
- Verify scopes include Gmail send permission

### Emails Not Sending

- Verify Gmail API is enabled in Google Cloud Console
- Check that OAuth scopes include Gmail send permission
- Review error logs in Trigger.dev dashboard
- Verify access token has not expired

### Build Errors

- Check TypeScript version compatibility
- Verify all dependencies are installed: `npm install`
- Clear build cache: `rm -rf node_modules/.cache`
- Check `tsconfig.json` configuration

### Development Server Issues

- Ensure Node.js version is 16+
- Check that port is not already in use
- Verify `.env` file exists and is configured
- Check Trigger.dev account status

## Environment Variables

See `.env.example` for all required environment variables.

## Additional Resources

- [Trigger.dev Documentation](https://trigger.dev/docs)
- [Trigger.dev Dashboard](https://cloud.trigger.dev)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)

## Quick Start (Windows)

Use the provided `start.bat` script:

```bash
start.bat
```

This script will:
1. Check for `.env` file
2. Install dependencies if needed
3. Verify TypeScript compilation
4. Start the development server

