import { task } from "@trigger.dev/sdk/v3";
import { getValidAccessToken } from "../utils/tokenRefresh";
import { sendEmail, clearGmailCache } from "../utils/gmailSender";

// Types for the campaign payload
interface CampaignPayload {
    campaignId: string;
    userId: string;
    csvSource: string;
    templateId: string;
    accessToken: string;
    refreshToken?: string;
    tokenExpiry?: string;
    backendUrl: string;
}

interface Contact {
    id: string;
    email: string;
    name?: string;
    company?: string;
    phone?: string;
    custom_fields?: Record<string, any>;
}

interface Template {
    id: string;
    subject: string;
    body: string;
}

/**
 * Main task for sending email campaigns
 * Optimized for memory efficiency
 */
export const sendEmailCampaign = task({
    id: "send-email-campaign",
    run: async (payload: CampaignPayload) => {
        // Debug: log the received payload
        console.log("Received payload:", JSON.stringify(payload, null, 2));
        
        // Validate payload
        if (!payload || !payload.campaignId) {
            throw new Error(`Invalid payload received: ${JSON.stringify(payload)}`);
        }
        
        console.log(`Starting email campaign: ${payload.campaignId}`);

        let totalSent = 0;
        let totalFailed = 0;
        let totalContacts = 0;

        try {
            // Update campaign status to 'running'
            await updateCampaignStatus(payload.backendUrl, payload.campaignId, 'running');

            // Get valid access token (refresh if needed)
            let tokenInfo = await getValidAccessToken(
                {
                    accessToken: payload.accessToken,
                    refreshToken: payload.refreshToken,
                    tokenExpiry: payload.tokenExpiry,
                },
                process.env.GOOGLE_CLIENT_ID!,
                process.env.GOOGLE_CLIENT_SECRET!
            );

            console.log(`Using access token, expires: ${tokenInfo.expiry}`);

            // Fetch template first (small data)
            const template = await fetchTemplate(
                payload.backendUrl,
                payload.userId,
                payload.templateId
            );
            console.log(`Using template: ${template.subject}`);

            // Process contacts in pages to avoid loading all at once
            const pageSize = 50;
            let page = 1;
            let hasMore = true;

            while (hasMore) {
                // Fetch a page of contacts
                const { contacts, total } = await fetchContactsPage(
                    payload.backendUrl,
                    payload.userId,
                    payload.csvSource,
                    page,
                    pageSize
                );

                if (page === 1) {
                    totalContacts = total;
                    console.log(`Total contacts to process: ${totalContacts}`);
                }

                if (contacts.length === 0) {
                    hasMore = false;
                    break;
                }

                // Process this batch of contacts
                for (const contact of contacts) {
                    try {
                        // Refresh token if needed every 20 emails
                        if ((totalSent + totalFailed) > 0 && (totalSent + totalFailed) % 20 === 0) {
                            const newTokenInfo = await getValidAccessToken(
                                {
                                    accessToken: tokenInfo.token,
                                    refreshToken: payload.refreshToken,
                                    tokenExpiry: tokenInfo.expiry,
                                },
                                process.env.GOOGLE_CLIENT_ID!,
                                process.env.GOOGLE_CLIENT_SECRET!
                            );
                            
                            // If token changed, clear the cached Gmail client
                            if (newTokenInfo.token !== tokenInfo.token) {
                                clearGmailCache();
                                tokenInfo = newTokenInfo;
                                console.log(`Token refreshed at email ${totalSent + totalFailed}`);
                            }
                        }

                        // Personalize and send email
                        const subject = personalizeText(template.subject, contact);
                        const body = personalizeText(template.body, contact);

                        const result = await sendEmail(tokenInfo.token, {
                            to: contact.email,
                            subject,
                            body,
                        });

                        if (result.success) {
                            totalSent++;
                            // Log successful email with Gmail IDs for reply tracking
                            await logEmail(payload.backendUrl, {
                                campaign_id: payload.campaignId,
                                user_id: payload.userId,
                                contact_id: contact.id,
                                template_id: payload.templateId,
                                to_email: contact.email,
                                subject,
                                body,
                                status: 'sent',
                                sent_at: new Date().toISOString(),
                                gmail_message_id: result.messageId,
                                gmail_thread_id: result.threadId,
                            });
                        } else {
                            totalFailed++;
                            console.error(`Failed: ${contact.email} - ${result.error}`);
                            // Log failed email
                            await logEmail(payload.backendUrl, {
                                campaign_id: payload.campaignId,
                                user_id: payload.userId,
                                contact_id: contact.id,
                                template_id: payload.templateId,
                                to_email: contact.email,
                                subject,
                                body,
                                status: 'failed',
                                error_message: result.error,
                            });
                        }

                        // Small delay between emails (300ms)
                        await delay(300);

                    } catch (error: any) {
                        totalFailed++;
                        console.error(`Error sending to ${contact.email}:`, error.message);
                        // Log error
                        await logEmail(payload.backendUrl, {
                            campaign_id: payload.campaignId,
                            user_id: payload.userId,
                            contact_id: contact.id,
                            template_id: payload.templateId,
                            to_email: contact.email,
                            subject: template.subject,
                            body: template.body,
                            status: 'failed',
                            error_message: error.message,
                        });
                    }
                }

                // Update progress after each page
                await updateCampaignProgress(payload.backendUrl, payload.campaignId, {
                    processed: totalSent + totalFailed,
                    sent: totalSent,
                    failed: totalFailed,
                });

                console.log(`Progress: ${totalSent + totalFailed}/${totalContacts} (${totalSent} sent, ${totalFailed} failed)`);

                // Check if there are more pages
                hasMore = contacts.length === pageSize;
                page++;

                // Small delay between pages
                await delay(1000);
            }

            // Update campaign status to 'completed'
            await updateCampaignStatus(
                payload.backendUrl,
                payload.campaignId,
                'completed'
            );

            console.log(`Campaign completed: ${totalSent} sent, ${totalFailed} failed`);

            return {
                success: true,
                sent: totalSent,
                failed: totalFailed,
                total: totalContacts,
            };

        } catch (error: any) {
            console.error('Campaign failed:', error.message);

            // Update campaign status to 'failed'
            await updateCampaignStatus(
                payload.backendUrl,
                payload.campaignId,
                'failed',
                error.message
            );

            throw error;
        }
    },
});

/**
 * Simple delay helper
 */
function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Fetch a page of contacts from backend API
 */
async function fetchContactsPage(
    backendUrl: string,
    userId: string,
    csvSource: string,
    page: number,
    pageSize: number
): Promise<{ contacts: Contact[]; total: number }> {
    const response = await fetch(
        `${backendUrl}/contacts/by-source/${encodeURIComponent(csvSource)}?page=${page}&page_size=${pageSize}`,
        {
            headers: {
                'X-User-Id': userId,
            },
        }
    );

    if (!response.ok) {
        throw new Error(`Failed to fetch contacts: ${response.statusText}`);
    }

    const data = await response.json();
    return {
        contacts: data.contacts || [],
        total: data.total || 0,
    };
}

/**
 * Fetch template from backend API
 */
async function fetchTemplate(
    backendUrl: string,
    userId: string,
    templateId: string
): Promise<Template> {
    const response = await fetch(`${backendUrl}/templates/${templateId}`, {
        headers: {
            'X-User-Id': userId,
        },
    });

    if (!response.ok) {
        throw new Error(`Failed to fetch template: ${response.statusText}`);
    }

    const data = await response.json();
    return data.template;
}

/**
 * Update campaign status via webhook
 */
async function updateCampaignStatus(
    backendUrl: string,
    campaignId: string,
    status: string,
    errorMessage?: string
): Promise<void> {
    try {
        await fetch(`${backendUrl}/webhooks/trigger/campaign-status`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                campaign_id: campaignId,
                status,
                error_message: errorMessage,
            }),
        });
    } catch (error) {
        console.error('Failed to update campaign status:', error);
    }
}

/**
 * Update campaign progress via webhook
 */
async function updateCampaignProgress(
    backendUrl: string,
    campaignId: string,
    progress: { processed: number; sent: number; failed: number }
): Promise<void> {
    try {
        await fetch(`${backendUrl}/webhooks/trigger/campaign-progress`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                campaign_id: campaignId,
                ...progress,
            }),
        });
    } catch (error) {
        console.error('Failed to update campaign progress:', error);
    }
}

/**
 * Log email to backend database
 */
interface EmailLogData {
    campaign_id: string;
    user_id: string;
    contact_id: string;
    template_id: string;
    to_email: string;
    subject: string;
    body: string;
    status: string;
    error_message?: string;
    sent_at?: string;
    gmail_message_id?: string;
    gmail_thread_id?: string;
}

async function logEmail(backendUrl: string, data: EmailLogData): Promise<void> {
    try {
        await fetch(`${backendUrl}/internal/email-logs`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
        });
    } catch (error) {
        console.error('Failed to log email:', error);
    }
}

/**
 * Personalize text with contact data
 */
function personalizeText(text: string, contact: Contact): string {
    let result = text;

    // Replace standard placeholders
    result = result.replace(/\{\{name\}\}/gi, contact.name || contact.email.split('@')[0]);
    result = result.replace(/\{\{email\}\}/gi, contact.email);
    result = result.replace(/\{\{company\}\}/gi, contact.company || '');
    result = result.replace(/\{\{phone\}\}/gi, contact.phone || '');

    // Replace custom fields
    if (contact.custom_fields) {
        for (const [key, value] of Object.entries(contact.custom_fields)) {
            const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'gi');
            result = result.replace(regex, String(value || ''));
        }
    }

    return result;
}
