import { schedules, task } from "@trigger.dev/sdk/v3";
import { getValidAccessToken } from "../utils/tokenRefresh";
import { 
    sendEmail, 
    getThread, 
    extractEmailBody, 
    getHeader 
} from "../utils/gmailSender";
import { generateAIReply, quickSentimentCheck, EmailContext } from "../agents/replyAgent";

interface UserWithToken {
    user_id: string;
    access_token: string;
    refresh_token: string;
    token_expiry: string;
}

interface Campaign {
    id: string;
    user_id: string;
    auto_reply_enabled: boolean;
    auto_reply_subject: string;
    auto_reply_body: string;
    max_replies_per_thread: number;
    prompt_id?: string;
    prompt_text?: string;  // Custom AI prompt (null = use system default)
}

interface Conversation {
    id: string;
    gmail_thread_id: string;
    contact_email: string;
    auto_replies_sent: number;
    status: string;
}

const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';

/**
 * Scheduled task to check for replies every minute
 */
export const scheduledReplyChecker = schedules.task({
    id: "scheduled-reply-checker",
    // Run every minute (standard 5-field cron - no seconds allowed)
    cron: "* * * * *",
    run: async () => {
        console.log("Starting scheduled reply check...");
        
        let totalReplies = 0;
        let totalAutoReplies = 0;

        try {
            // Get all users with auto-reply campaigns from backend
            const usersWithCampaigns = await fetchUsersWithAutoReplyCampaigns();
            
            console.log(`Found ${usersWithCampaigns.length} users with auto-reply campaigns`);

            for (const userData of usersWithCampaigns) {
                try {
                    // Get valid access token
                    const tokenInfo = await getValidAccessToken(
                        {
                            accessToken: userData.access_token,
                            refreshToken: userData.refresh_token,
                            tokenExpiry: userData.token_expiry,
                        },
                        process.env.GOOGLE_CLIENT_ID!,
                        process.env.GOOGLE_CLIENT_SECRET!
                    );

                    // Get campaigns for this user
                    const campaigns = await fetchAutoReplyCampaigns(userData.user_id);
                    
                    for (const campaign of campaigns) {
                        const { replies, autoReplies } = await checkCampaignReplies(
                            tokenInfo.token,
                            campaign
                        );
                        totalReplies += replies;
                        totalAutoReplies += autoReplies;
                    }
                } catch (error: any) {
                    console.error(`Error checking user ${userData.user_id}:`, error.message);
                }
            }

            console.log(`Reply check complete: ${totalReplies} replies, ${totalAutoReplies} auto-replies`);

            return {
                success: true,
                repliesFound: totalReplies,
                autoRepliesSent: totalAutoReplies,
            };

        } catch (error: any) {
            console.error('Scheduled reply check failed:', error.message);
            throw error;
        }
    },
});

/**
 * Manual task to check replies for a specific user (can be triggered on-demand)
 */
export const checkRepliesForUser = task({
    id: "check-replies-for-user",
    run: async (payload: {
        userId: string;
        accessToken: string;
        refreshToken?: string;
        tokenExpiry?: string;
    }) => {
        console.log(`Checking replies for user: ${payload.userId}`);
        
        let repliesFound = 0;
        let autoRepliesSent = 0;

        try {
            const tokenInfo = await getValidAccessToken(
                {
                    accessToken: payload.accessToken,
                    refreshToken: payload.refreshToken,
                    tokenExpiry: payload.tokenExpiry,
                },
                process.env.GOOGLE_CLIENT_ID!,
                process.env.GOOGLE_CLIENT_SECRET!
            );

            const campaigns = await fetchAutoReplyCampaigns(payload.userId);

            for (const campaign of campaigns) {
                const { replies, autoReplies } = await checkCampaignReplies(
                    tokenInfo.token,
                    campaign
                );
                repliesFound += replies;
                autoRepliesSent += autoReplies;
            }

            return {
                success: true,
                repliesFound,
                autoRepliesSent,
            };

        } catch (error: any) {
            console.error('Reply check failed:', error.message);
            throw error;
        }
    },
});

/**
 * Check replies for a specific campaign
 */
async function checkCampaignReplies(
    accessToken: string,
    campaign: Campaign
): Promise<{ replies: number; autoReplies: number }> {
    let replies = 0;
    let autoReplies = 0;

    try {
        const conversations = await fetchConversations(campaign.id);
        console.log(`Campaign ${campaign.id}: ${conversations.length} active conversations`);

        for (const conversation of conversations) {
            // Skip if max auto-replies reached
            if (conversation.auto_replies_sent >= campaign.max_replies_per_thread) {
                continue;
            }

            // Get thread from Gmail
            const { thread, error } = await getThread(accessToken, conversation.gmail_thread_id);

            if (error || !thread) {
                console.error(`Error fetching thread ${conversation.gmail_thread_id}: ${error}`);
                continue;
            }

            const messages = thread.messages || [];

            for (const message of messages) {
                const fromHeader = getHeader(message, 'From') || '';
                const messageId = message.id;

                // Check if from contact (not from us)
                if (!fromHeader.toLowerCase().includes(conversation.contact_email.toLowerCase())) {
                    continue;
                }

                // Check if already processed
                const processed = await checkMessageProcessed(messageId);
                if (processed) {
                    continue;
                }

                console.log(`New reply found in thread ${conversation.gmail_thread_id}`);
                replies++;

                // Extract message details
                const replySubject = getHeader(message, 'Subject') || '';
                const replyBody = extractEmailBody(message);
                const internalDate = message.internalDate
                    ? new Date(parseInt(message.internalDate))
                    : new Date();

                // Record the reply
                await recordReply({
                    conversation_id: conversation.id,
                    campaign_id: campaign.id,
                    gmail_message_id: messageId,
                    from_email: conversation.contact_email,
                    subject: replySubject,
                    body: replyBody,
                    replied_at: internalDate.toISOString(),
                });

                // Send auto-reply if enabled
                if (campaign.auto_reply_enabled &&
                    conversation.auto_replies_sent < campaign.max_replies_per_thread) {
                    
                    // Build conversation history for AI context
                    const conversationHistory = await fetchConversationHistory(conversation.id);

                    // Generate AI-powered reply
                    const emailContext: EmailContext = {
                        originalSubject: replySubject.replace(/^Re:\s*/i, ''),
                        contactEmail: conversation.contact_email,
                        userId: campaign.user_id, // Add user_id for calendar API calls
                        replySubject: replySubject,
                        replyBody: replyBody,
                        conversationHistory: conversationHistory,
                        campaignContext: campaign.auto_reply_body, // Use as context hint
                        customPrompt: campaign.prompt_text, // Custom AI prompt (undefined = use default)
                    };

                    console.log(`Generating AI reply for ${conversation.contact_email}...`);
                    const aiResponse = await generateAIReply(emailContext);

                    // Check if AI recommends replying
                    if (!aiResponse.shouldReply) {
                        console.log(`AI recommends not replying to ${conversation.contact_email}`);
                        continue;
                    }

                    const autoReplySubject = aiResponse.subject;
                    const autoReplyBody = aiResponse.body;

                    const originalMessageId = getHeader(message, 'Message-ID');

                    const sendResult = await sendEmail(accessToken, {
                        to: conversation.contact_email,
                        subject: autoReplySubject,
                        body: autoReplyBody,
                        threadId: conversation.gmail_thread_id,
                        inReplyTo: originalMessageId,
                        references: originalMessageId,
                    });

                    if (sendResult.success) {
                        autoReplies++;
                        console.log(`AI auto-reply sent to ${conversation.contact_email} (sentiment: ${aiResponse.sentiment})`);
                        
                        // Log if a meeting was booked
                        if (aiResponse.bookingUrl) {
                            console.log(`📅 Meeting booked! Booking URL: ${aiResponse.bookingUrl}`);
                        }

                        await recordAutoReply({
                            conversation_id: conversation.id,
                            campaign_id: campaign.id,
                            gmail_message_id: sendResult.messageId || '',
                            to_email: conversation.contact_email,
                            subject: autoReplySubject,
                            body: autoReplyBody,
                        });

                        if (aiResponse.sentiment === 'urgent') {
                            console.log(`⚠️ URGENT reply from ${conversation.contact_email} - consider personal follow-up`);
                        }
                    } else {
                        console.error(`Failed to send auto-reply: ${sendResult.error}`);
                    }
                }
            }
        }
    } catch (error: any) {
        console.error(`Error checking campaign ${campaign.id}:`, error.message);
    }

    return { replies, autoReplies };
}

/**
 * Fetch all users that have campaigns with auto-reply enabled
 */
async function fetchUsersWithAutoReplyCampaigns(): Promise<UserWithToken[]> {
    try {
        const response = await fetch(
            `${BACKEND_URL}/internal/users-with-auto-reply`,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.ok) {
            console.error('Failed to fetch users:', response.statusText);
            return [];
        }

        const data = await response.json();
        return data.users || [];
    } catch (error) {
        console.error('Error fetching users:', error);
        return [];
    }
}

/**
 * Fetch campaigns with auto-reply enabled for a user
 */
async function fetchAutoReplyCampaigns(userId: string): Promise<Campaign[]> {
    try {
        const response = await fetch(
            `${BACKEND_URL}/internal/auto-reply-campaigns?user_id=${userId}`,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        return data.campaigns || [];
    } catch (error) {
        console.error('Error fetching campaigns:', error);
        return [];
    }
}

/**
 * Fetch active conversations for a campaign
 */
async function fetchConversations(campaignId: string): Promise<Conversation[]> {
    try {
        const response = await fetch(
            `${BACKEND_URL}/internal/conversations/${campaignId}`,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.ok) {
            return [];
        }

        const data = await response.json();
        return data.conversations || [];
    } catch (error) {
        console.error('Error fetching conversations:', error);
        return [];
    }
}

/**
 * Check if a message has already been processed
 */
async function checkMessageProcessed(gmailMessageId: string): Promise<boolean> {
    try {
        const response = await fetch(
            `${BACKEND_URL}/internal/message-exists/${gmailMessageId}`,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.ok) return false;

        const data = await response.json();
        return data.exists || false;
    } catch (error) {
        return false;
    }
}

/**
 * Fetch conversation history for AI context
 */
async function fetchConversationHistory(conversationId: string): Promise<Array<{
    direction: 'inbound' | 'outbound';
    subject: string;
    body: string;
    isAutoReply: boolean;
}>> {
    try {
        const response = await fetch(
            `${BACKEND_URL}/internal/conversation-history/${conversationId}`,
            { headers: { 'Content-Type': 'application/json' } }
        );

        if (!response.ok) return [];

        const data = await response.json();
        return (data.messages || []).map((msg: any) => ({
            direction: msg.direction,
            subject: msg.subject || '',
            body: msg.body || '',
            isAutoReply: msg.is_auto_reply || false,
        }));
    } catch (error) {
        console.error('Error fetching conversation history:', error);
        return [];
    }
}

/**
 * Record an inbound reply
 */
async function recordReply(data: {
    conversation_id: string;
    campaign_id: string;
    gmail_message_id: string;
    from_email: string;
    subject: string;
    body: string;
    replied_at: string;
}): Promise<void> {
    try {
        await fetch(`${BACKEND_URL}/internal/record-reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    } catch (error) {
        console.error('Error recording reply:', error);
    }
}

/**
 * Record an auto-reply that was sent
 */
async function recordAutoReply(data: {
    conversation_id: string;
    campaign_id: string;
    gmail_message_id: string;
    to_email: string;
    subject: string;
    body: string;
}): Promise<void> {
    try {
        await fetch(`${BACKEND_URL}/internal/record-auto-reply`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        });
    } catch (error) {
        console.error('Error recording auto-reply:', error);
    }
}
