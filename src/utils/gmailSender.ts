/**
 * Lightweight Gmail sender using raw fetch API
 * No heavy googleapis dependency!
 */

export interface EmailData {
    to: string;
    subject: string;
    body: string;
    from?: string;
    threadId?: string;      // For replying in same thread
    inReplyTo?: string;     // Message-ID of email we're replying to
    references?: string;    // References header for threading
}

export interface SendEmailResult {
    success: boolean;
    messageId?: string;     // Gmail's internal message ID
    threadId?: string;      // Gmail's thread ID (for tracking replies)
    error?: string;
}

/**
 * Send an email using Gmail REST API directly (no googleapis library)
 */
export async function sendEmail(
    accessToken: string,
    emailData: EmailData
): Promise<SendEmailResult> {
    try {
        // Create RFC 2822 email message
        const rawMessage = createRawEmail(emailData);

        // Build request body
        const requestBody: any = {
            raw: rawMessage,
        };

        // If replying to a thread, include threadId
        if (emailData.threadId) {
            requestBody.threadId = emailData.threadId;
        }

        // Send via Gmail REST API
        const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            const errorMessage = errorData?.error?.message || response.statusText;
            throw new Error(errorMessage);
        }

        const data = await response.json();

        return {
            success: true,
            messageId: data.id,
            threadId: data.threadId,
        };
    } catch (error: any) {
        console.error(`Error sending to ${emailData.to}:`, error.message);
        return {
            success: false,
            error: error.message || 'Unknown error',
        };
    }
}

/**
 * Create base64url encoded RFC 2822 email message
 */
function createRawEmail(emailData: EmailData): string {
    const { to, subject, body, from, inReplyTo, references } = emailData;

    // Build email headers (RFC 2822 format)
    const headerParts: string[] = [
        `To: ${to}`,
    ];
    
    if (from) {
        headerParts.push(`From: ${from}`);
    }
    
    // Add threading headers for replies
    if (inReplyTo) {
        headerParts.push(`In-Reply-To: ${inReplyTo}`);
    }
    if (references) {
        headerParts.push(`References: ${references}`);
    }
    
    headerParts.push(
        `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
        'MIME-Version: 1.0',
        'Content-Type: text/html; charset=UTF-8',
    );
    
    // Join headers, add blank line, then body
    const message = headerParts.join('\r\n') + '\r\n\r\n' + body;

    // Convert to base64url format
    const base64 = Buffer.from(message).toString('base64');
    return base64
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

/**
 * Clear Gmail cache - no longer needed but kept for compatibility
 */
export function clearGmailCache(): void {
    // No-op - we don't cache anything now
}

/**
 * Send emails in a batch
 */
export async function sendEmailBatch(
    accessToken: string,
    emails: EmailData[],
    _batchSize: number = 10,
    delayMs: number = 500
): Promise<{ sent: number; failed: number; errors: string[] }> {
    let sent = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const email of emails) {
        const result = await sendEmail(accessToken, email);
        
        if (result.success) {
            sent++;
        } else {
            failed++;
            errors.push(`${email.to}: ${result.error}`);
        }

        // Delay between emails
        if (delayMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }

    return { sent, failed, errors };
}

/**
 * Get messages from Gmail inbox
 */
export async function getInboxMessages(
    accessToken: string,
    query: string = '',
    maxResults: number = 10
): Promise<{ messages: any[]; error?: string }> {
    try {
        const params = new URLSearchParams({
            maxResults: maxResults.toString(),
        });
        if (query) {
            params.append('q', query);
        }

        const response = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages?${params}`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                },
            }
        );

        if (!response.ok) {
            throw new Error(`Failed to fetch messages: ${response.statusText}`);
        }

        const data = await response.json();
        return { messages: data.messages || [] };
    } catch (error: any) {
        return { messages: [], error: error.message };
    }
}

/**
 * Get a specific message by ID
 */
export async function getMessage(
    accessToken: string,
    messageId: string
): Promise<{ message?: any; error?: string }> {
    try {
        const response = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                },
            }
        );

        if (!response.ok) {
            throw new Error(`Failed to fetch message: ${response.statusText}`);
        }

        const data = await response.json();
        return { message: data };
    } catch (error: any) {
        return { error: error.message };
    }
}

/**
 * Get messages in a specific thread
 */
export async function getThread(
    accessToken: string,
    threadId: string
): Promise<{ thread?: any; error?: string }> {
    try {
        const response = await fetch(
            `https://gmail.googleapis.com/gmail/v1/users/me/threads/${threadId}?format=full`,
            {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                },
            }
        );

        if (!response.ok) {
            throw new Error(`Failed to fetch thread: ${response.statusText}`);
        }

        const data = await response.json();
        return { thread: data };
    } catch (error: any) {
        return { error: error.message };
    }
}

/**
 * Extract email body from Gmail message
 */
export function extractEmailBody(message: any): string {
    const payload = message.payload;
    
    // Try to get body from parts
    if (payload.parts) {
        for (const part of payload.parts) {
            if (part.mimeType === 'text/plain' && part.body?.data) {
                return Buffer.from(part.body.data, 'base64').toString('utf-8');
            }
            if (part.mimeType === 'text/html' && part.body?.data) {
                return Buffer.from(part.body.data, 'base64').toString('utf-8');
            }
        }
    }
    
    // Try direct body
    if (payload.body?.data) {
        return Buffer.from(payload.body.data, 'base64').toString('utf-8');
    }
    
    return '';
}

/**
 * Extract header value from Gmail message
 */
export function getHeader(message: any, headerName: string): string | undefined {
    const headers = message.payload?.headers || [];
    const header = headers.find((h: any) => h.name.toLowerCase() === headerName.toLowerCase());
    return header?.value;
}
