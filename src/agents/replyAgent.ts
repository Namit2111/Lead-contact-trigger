/**
 * AI Reply Agent using Vercel AI SDK + Gemini 2.0 Flash
 * With calendar tools for availability and booking
 */
import { generateText, tool } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';

export interface EmailContext {
    originalSubject: string;
    contactEmail: string;
    contactName?: string;
    userId: string;  // User ID for calendar API calls
    replySubject: string;
    replyBody: string;
    conversationHistory: Array<{
        direction: 'inbound' | 'outbound';
        subject: string;
        body: string;
        isAutoReply: boolean;
    }>;
    campaignContext?: string;
    customPrompt?: string;  // Custom AI prompt (undefined = use default)
    calToolsEnabled?: boolean;  // Whether AI can use calendar tools (get availability, book meetings)
}

const BACKEND_URL = process.env.BACKEND_URL || (() => {
    throw new Error('BACKEND_URL environment variable is required. Set it in your .env file or environment variables.');
})();

// Calendar helper functions
interface CalendarAvailability {
    connected: boolean;
    available_slots: Array<{
        date: string;
        time: string;
        start_iso: string;
        end_iso: string;
        duration: string;
        timezone: string;
    }>;
    booking_link: string | null;
    event_type_name?: string;
    error?: string;
}

interface BookingResult {
    success: boolean;
    booking_id?: string;
    booking_url?: string;
    error?: string;
}

async function getCalendarAvailability(userId: string, daysAhead: number = 30): Promise<CalendarAvailability> {
    try {
        const url = `${BACKEND_URL}/calendar/availability?days=${daysAhead}&timezone=UTC`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-User-Id': userId,
            },
        });

        if (!response.ok) {
            return {
                connected: false,
                available_slots: [],
                booking_link: null,
                error: `Backend error ${response.status}`,
            };
        }

        const data = await response.json();

        if (!data.connected) {
            return {
                connected: false,
                available_slots: [],
                booking_link: null,
                event_type_name: data.event_type_name,
                error: data.error || 'Calendar not connected',
            };
        }

        const slots = (data.slots || []).slice(0, 30);
        const formattedSlots = slots.map((slot: any) => {
            const start = new Date(slot.start);
            const end = slot.end ? new Date(slot.end) : new Date(start.getTime() + 30 * 60000);
            const duration = Math.round((end.getTime() - start.getTime()) / 60000);
            return {
                date: start.toISOString().split('T')[0],
                time: start.toISOString().split('T')[1].split('.')[0],
                start_iso: start.toISOString(),
                end_iso: end.toISOString(),
                duration: `${duration}min`,
                timezone: slot.time_zone || 'UTC',
            };
        });

        return {
            connected: true,
            available_slots: formattedSlots,
            booking_link: data.booking_link || null,
            event_type_name: data.event_type_name,
        };
    } catch (error: any) {
        return {
            connected: false,
            available_slots: [],
            booking_link: null,
            error: error.message,
        };
    }
}

async function bookMeeting(
    userId: string,
    startTime: string,
    endTime: string,
    attendeeEmail: string,
    attendeeName: string,
    notes?: string
): Promise<BookingResult> {
    try {
        const response = await fetch(`${BACKEND_URL}/calendar/book`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-User-Id': userId,
            },
            body: JSON.stringify({
                start: startTime,
                end: endTime,
                attendee_email: attendeeEmail,
                attendee_name: attendeeName,
                notes: notes || '',
            }),
        });

        if (!response.ok) {
            const text = await response.text();
            return {
                success: false,
                error: `Booking failed (${response.status}): ${text}`,
            };
        }

        const bookingData = await response.json();
        return {
            success: bookingData.success,
            booking_id: bookingData.booking_id,
            booking_url: bookingData.booking_url,
            error: bookingData.error,
        };
    } catch (error: any) {
        return {
            success: false,
            error: error.message,
        };
    }
}

// System default prompt - used when no custom prompt is provided
const DEFAULT_PROMPT = `You are a professional sales representative. Your goal is to engage with prospects, understand their needs, and guide conversations toward scheduling meetings.

CRITICAL INSTRUCTIONS FOR CALENDAR BOOKING:
1. You have access to the contact's email and name from the conversation context - NEVER ask for these
2. When the contact agrees to meet, schedule, or book a meeting, IMMEDIATELY use the bookMeeting tool
3. Use the contact's email and name from the conversation context - DO NOT ask questions
4. If they ask about availability, use getCalendarAvailability to show them times
5. When booking, choose the next available slot that makes sense based on the conversation
6. After booking, ALWAYS include the booking link in your reply
7. Be proactive - if they express interest in meeting, book it immediately without asking for confirmation

General Instructions:
1. ALWAYS respond to every email - your job is to try and keep the conversation going
2. Read the conversation context carefully and respond appropriately
3. Be friendly, professional, and consultative
4. Your primary objective is to schedule a meeting when appropriate
5. Keep replies concise but compelling (3-5 sentences typically)
6. Address their specific questions or concerns
7. If they seem uninterested, acknowledge their position but offer value
8. Never give up - always find a way to continue the conversation`;

export interface AgentResponse {
    subject: string;
    body: string;
    shouldReply: boolean;
    sentiment: 'positive' | 'neutral' | 'negative' | 'urgent';
    bookingUrl?: string;  // Booking link if a meeting was booked
    bookingId?: string;   // Booking ID if a meeting was booked
}

/**
 * Generate an AI-powered reply using Gemini 2.0 Flash with calendar tools
 */
export async function generateAIReply(context: EmailContext): Promise<AgentResponse> {
    // Check all possible env var names for Gemini API key
    const apiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY || 
                   process.env.GOOGLE_GEMINI_API_KEY || 
                   process.env.GOOGLE_API_KEY;
    
    if (!apiKey) {
        console.warn('Gemini API key not set, using fallback reply');
        return getFallbackReply(context);
    }

    try {
        // Build conversation history for context
        const historyText = context.conversationHistory
            .slice(-5) // Last 5 messages for context
            .map((msg, i) => `[${msg.direction.toUpperCase()}]: ${msg.body.substring(0, 300)}`)
            .join('\n\n');

        // Use custom prompt if provided, otherwise use default
        const basePrompt = context.customPrompt || DEFAULT_PROMPT;

        // Extract contact information - CRITICAL: Use these without asking
        const contactEmail = context.contactEmail;
        const contactName = context.contactName || contactEmail.split('@')[0] || 'there';
        const userId = context.userId;
        const calToolsEnabled = context.calToolsEnabled ?? false;

        // Get current date for context
        const currentDate = new Date();
        const currentDateStr = currentDate.toISOString().split('T')[0];
        const currentDateTimeStr = currentDate.toISOString();

        // Build the full system prompt with contact info
        // NOTE: userId is NOT exposed to AI - it's only used internally in tool functions
        let systemPrompt = `${basePrompt}

CONTACT INFORMATION (USE THESE - DO NOT ASK):
- Contact Email: ${contactEmail}
- Contact Name: ${contactName}

Today's Date: ${currentDateStr}

Context: ${context.campaignContext || 'Business outreach'}

Previous conversation:
${historyText || 'No previous messages.'}

Latest email from ${contactName} (${contactEmail}):
Subject: ${context.replySubject}
Message: ${context.replyBody}`;

        // Add calendar-specific instructions only if tools are enabled
        if (calToolsEnabled) {
            systemPrompt += `

IMPORTANT - CURRENT DATE/TIME: ${currentDateTimeStr}
When booking meetings, ONLY use times from the getCalendarAvailability tool results.
These are the ONLY valid future time slots. Do NOT make up times.
Remember: When they agree to meet, book immediately using contactEmail and contactName above.`;
        }

        // Define calendar tools (only if enabled)
        const tools = calToolsEnabled ? {
            getCalendarAvailability: tool({
                description: 'Get calendar availability for a specified number of days ahead. Use this when the contact asks about available times, wants to see slots, or asks "when are you available?".',
                parameters: z.object({
                    daysAhead: z.number().describe('Number of days to check ahead (default: 30)').optional(),
                }),
                execute: async ({ daysAhead = 30 }) => {
                    const availability = await getCalendarAvailability(userId, daysAhead);
                    return JSON.stringify(availability, null, 2);
                },
            }),
            bookMeeting: tool({
                description: 'Book a meeting slot IMMEDIATELY when the contact agrees to meet, wants to schedule, or says yes to a meeting. Use contactEmail and contactName from context - NEVER ask for these. Choose the next available slot that makes sense.',
                parameters: z.object({
                    startTime: z.string().describe('Start time in ISO format (e.g., "2024-12-07T14:00:00Z") - use from available slots'),
                    endTime: z.string().describe('End time in ISO format (e.g., "2024-12-07T14:30:00Z") - use from available slots'),
                    attendeeEmail: z.string().email().describe('Email address - use the contactEmail from context'),
                    attendeeName: z.string().describe('Full name - use the contactName from context'),
                    notes: z.string().optional().describe('Optional notes about the meeting based on conversation context'),
                }),
                execute: async ({ startTime, endTime, attendeeEmail, attendeeName, notes }) => {
                    const result = await bookMeeting(userId, startTime, endTime, attendeeEmail, attendeeName, notes);
                    return JSON.stringify(result, null, 2);
                },
            }),
        } : undefined;

        // Set API key in environment for Google AI SDK
        const originalApiKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
        process.env.GOOGLE_GENERATIVE_AI_API_KEY = apiKey;

        // Build generate options - only include tools if calendar tools are enabled
        const generateOptions: any = {
            model: google('gemini-2.5-flash-lite'),
            system: systemPrompt,
            prompt: calToolsEnabled
                ? `Generate a professional reply to the latest email. Use tools if needed to check availability or book meetings.`
                : `Generate a professional reply to the latest email.`,
            maxTokens: 1500,
        };

        // Only add tools if they're defined (when cal_tools_enabled is true)
        if (tools) {
            generateOptions.tools = tools;
            generateOptions.maxSteps = 5; // Allow multiple tool calls
        }

        const result = await generateText(generateOptions);

        // Restore original API key if it was set
        if (originalApiKey) {
            process.env.GOOGLE_GENERATIVE_AI_API_KEY = originalApiKey;
        }

        // Extract response text from the last step
        let responseText = result.text?.trim() || '';
        if (result.steps && result.steps.length > 0) {
            const lastStep = result.steps[result.steps.length - 1];
            responseText = lastStep.text?.trim() || responseText;
        }

        // Extract booking information from tool results
        let bookingUrl: string | undefined;
        let bookingId: string | undefined;
        
        if (result.steps) {
            for (const step of result.steps) {
                // Check tool results (not toolCalls)
                const toolResults = (step as any).toolResults;
                if (toolResults && Array.isArray(toolResults)) {
                    for (const toolResult of toolResults) {
                        if (toolResult.toolName === 'bookMeeting' && toolResult.result) {
                            try {
                                const bookingResult = typeof toolResult.result === 'string' 
                                    ? JSON.parse(toolResult.result)
                                    : toolResult.result;
                                    
                                if (bookingResult && bookingResult.success) {
                                    bookingUrl = bookingResult.booking_url;
                                    bookingId = bookingResult.booking_id;
                                    
                                    // Ensure booking link is in the response text
                                    if (bookingUrl && !responseText.includes(bookingUrl)) {
                                        responseText += `\n\nHere's your booking link: ${bookingUrl}`;
                                    }
                                }
                            } catch (e) {
                                // Try to extract URL from text if result is a string
                                if (typeof toolResult.result === 'string') {
                                    const urlMatch = toolResult.result.match(/https?:\/\/[^\s"']+/);
                                    if (urlMatch) {
                                        bookingUrl = urlMatch[0];
                                        if (bookingUrl && !responseText.includes(bookingUrl)) {
                                            responseText += `\n\nHere's your booking link: ${bookingUrl}`;
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // Detect sentiment from the original email (for logging/analytics only)
        const sentiment = quickSentimentCheck(context.replyBody);

        // Always reply - our job is to try
        return {
            subject: `Re: ${context.replySubject.replace(/^Re:\s*/i, '')}`,
            body: responseText,
            shouldReply: true,
            sentiment,
            bookingUrl,
            bookingId,
        };

    } catch (error: any) {
        console.error('AI agent error:', error.message);
        return getFallbackReply(context);
    }
}

/**
 * Fallback reply when AI is not available
 */
function getFallbackReply(context: EmailContext): AgentResponse {
    const contactName = context.contactName || 'there';
    
    return {
        subject: `Re: ${context.replySubject.replace(/^Re:\s*/i, '')}`,
        body: `Hi ${contactName},

Thank you for getting back to us! I've received your message and will review it shortly.

Best regards`,
        shouldReply: true,
        sentiment: 'neutral',
    };
}

/**
 * Quick sentiment check
 */
export function quickSentimentCheck(emailBody: string): 'positive' | 'neutral' | 'negative' | 'urgent' {
    const lowerBody = emailBody.toLowerCase();
    
    const unsubscribePatterns = [
        'unsubscribe', 'remove me', 'stop emailing', 'opt out', 'take me off',
        'don\'t contact', 'not interested', 'leave me alone', 'stop', 'no thanks'
    ];
    
    const urgentPatterns = ['urgent', 'asap', 'emergency', 'immediately', 'help!'];
    const positivePatterns = ['interested', 'tell me more', 'sounds great', 'yes', 'definitely', 'love'];
    
    if (unsubscribePatterns.some(p => lowerBody.includes(p))) {
        return 'negative';
    }
    if (urgentPatterns.some(p => lowerBody.includes(p))) {
        return 'urgent';
    }
    if (positivePatterns.some(p => lowerBody.includes(p))) {
        return 'positive';
    }
    
    return 'neutral';
}
