# Trigger.dev Email Campaign Worker

This is the Trigger.dev worker that handles background email campaign processing for the Lead Contact application.

## Features

- ✅ **Automatic Token Refresh**: Refreshes OAuth tokens during long-running campaigns
- ✅ **Batch Processing**: Sends emails in batches to avoid rate limits
- ✅ **Progress Tracking**: Updates campaign status and progress in real-time
- ✅ **Error Handling**: Robust error handling with retry logic
- ✅ **Personalization**: Supports template variables like {{name}}, {{email}}, etc.

## Setup

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment Variables

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Required environment variables:

- `TRIGGER_SECRET_KEY`: Your Trigger.dev secret key
- `TRIGGER_PROJECT_ID`: Your Trigger.dev project ID
- `GOOGLE_CLIENT_ID`: Google OAuth client ID
- `GOOGLE_CLIENT_SECRET`: Google OAuth client secret
- `BACKEND_URL`: URL of your backend API (e.g., http://localhost:8000)

### 3. Get Trigger.dev Credentials

1. Go to [Trigger.dev](https://trigger.dev)
2. Sign up or log in
3. Create a new project
4. Copy your Project ID and Secret Key from the project settings

### 4. Update trigger.config.ts

Replace `proj_your_project_id` with your actual Trigger.dev project ID in `trigger.config.ts`.

## Development

### Run in Development Mode

```bash
npm run dev
```

This will:
- Start the Trigger.dev development server
- Watch for file changes
- Allow you to test tasks locally

### Test the Task

You can test the email campaign task by triggering it from your backend or using the Trigger.dev dashboard.

#### Test Payload Example:

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

## Deployment

### Deploy to Trigger.dev Cloud

```bash
npm run deploy
```

This will:
- Build your TypeScript code
- Upload the task to Trigger.dev
- Make it available for production use

## Project Structure

```
trigger/
├── src/
│   ├── trigger/
│   │   └── emailCampaign.ts    # Main email campaign task
│   └── utils/
│       ├── tokenRefresh.ts     # OAuth token refresh utilities
│       └── gmailSender.ts      # Gmail API email sending
├── trigger.config.ts           # Trigger.dev configuration
├── tsconfig.json              # TypeScript configuration
├── package.json               # Dependencies and scripts
└── .env                       # Environment variables (not in git)
```

## How It Works

### 1. Campaign Trigger

When a campaign is created in the backend, it triggers this worker with:
- Campaign details
- OAuth tokens (access + refresh)
- Template and contact information

### 2. Token Management

The worker automatically:
- Checks if the access token is expired
- Refreshes it using the refresh token if needed
- Updates the token before each batch of emails

### 3. Email Sending

Emails are sent in batches:
- Default batch size: 10 emails
- Delay between batches: 2 seconds
- Personalization applied to each email

### 4. Progress Updates

The worker sends progress updates to the backend:
- Status changes (running, completed, failed)
- Progress counters (processed, sent, failed)

## Token Refresh Flow

```
1. Check token expiry
   ↓
2. If expired or expiring soon (< 5 min)
   ↓
3. Use refresh token to get new access token
   ↓
4. Continue with new token
```

## API Endpoints Used

The worker calls these backend endpoints:

- `GET /api/contacts/by-source/{source}` - Fetch contacts
- `GET /api/templates/{id}` - Fetch email template
- `POST /api/webhooks/trigger/campaign-status` - Update campaign status
- `POST /api/webhooks/trigger/campaign-progress` - Update progress

## Error Handling

The worker handles errors gracefully:

1. **Token Refresh Failures**: Marks campaign as failed
2. **Email Send Failures**: Continues with remaining emails, tracks failures
3. **API Failures**: Retries with exponential backoff

## Rate Limiting

To avoid Gmail API rate limits:

- Batch size: 10 emails per batch
- Delay: 2 seconds between batches
- Max: ~300 emails per minute

## Monitoring

Monitor your tasks in the Trigger.dev dashboard:

1. View running tasks
2. Check logs and errors
3. See execution history
4. Monitor performance metrics

## Troubleshooting

### Task Not Triggering

- Check that `TRIGGER_SECRET_KEY` is correct
- Verify backend can reach Trigger.dev API
- Check Trigger.dev dashboard for errors

### Token Refresh Failing

- Verify `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`
- Ensure refresh token is valid
- Check that OAuth consent screen is configured

### Emails Not Sending

- Verify Gmail API is enabled in Google Cloud Console
- Check that OAuth scopes include Gmail send permission
- Review error logs in Trigger.dev dashboard

## Support

For issues:
- Check [Trigger.dev Documentation](https://trigger.dev/docs)
- Review backend logs
- Check Trigger.dev dashboard for task errors
