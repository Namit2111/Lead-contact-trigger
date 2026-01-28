/**
 * Simple Test Bot with Cal.com Tools and Gemini API
 *
 * Interactive bot that uses Cal.com API and Gemini API directly
 *
 * Usage: npx tsx src/testBot.ts
 */

import { generateText, tool } from 'ai';
import { google } from '@ai-sdk/google';
import { z } from 'zod';
import * as readline from 'readline';

// Configuration
// Note: For production, set BACKEND_URL environment variable (e.g., https://lead-contact.onrender.com)
// localhost fallback is only for local testing
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:8000';
const USER_ID = process.env.TEST_USER_ID || '691cdc31fb39528053b632d7'; // send as X-User-Id header

// Calendar Tools
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

/**
 * Get calendar availability (direct API call with API key)
 */
async function getCalendarAvailability(daysAhead: number = 30): Promise<CalendarAvailability> {
    try {
        console.log('🔍 Fetching availability from backend...');
        const url = `${BACKEND_URL}/calendar/availability?days=${daysAhead}&timezone=UTC`;
        const response = await fetch(url, {
            method: 'GET',
            headers: {
                'Content-Type': 'application/json',
                'X-User-Id': USER_ID,
            },
        });

        if (!response.ok) {
            const text = await response.text();
            return {
                connected: false,
                available_slots: [],
                booking_link: null,
                error: `Backend error ${response.status}: ${text}`,
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
        console.error('❌ Error fetching calendar:', error.message);
        return {
            connected: false,
            available_slots: [],
            booking_link: null,
            error: error.message,
        };
    }
}

/**
 * Book a meeting (direct API call)
 */
async function bookMeeting(
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
                'X-User-Id': USER_ID,
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

/**
 * Format calendar availability for AI
 */
function formatAvailabilityForAI(availability: CalendarAvailability): string {
    if (!availability.connected) {
        return 'Calendar is not connected. No meeting scheduling available.';
    }

    if (availability.available_slots.length === 0) {
        return `Calendar is connected (${availability.event_type_name || 'Event'}), but no available slots found. 
Direct booking link: ${availability.booking_link || 'N/A'}`;
    }

    const slotsText = availability.available_slots
        .slice(0, 10)
        .map((slot, idx) => `${idx + 1}. ${slot.date} at ${slot.time} ${slot.timezone} (${slot.duration}) - ISO: ${slot.start_iso}`)
        .join('\n');

    return `Calendar is connected! Event Type: ${availability.event_type_name || 'Event'}
Total available slots: ${availability.available_slots.length}

Next available slots:
${slotsText}
${availability.available_slots.length > 10 ? `... and ${availability.available_slots.length - 10} more slots\n` : ''}

Direct booking link: ${availability.booking_link || 'N/A'}

Note: When booking, use the ISO start time from the slot information.`;
}

/**
 * Generate AI reply with Gemini API using tool calling
 */
async function generateReplyWithGemini(
    userMessage: string,
    calendar: CalendarAvailability
): Promise<{ text: string; toolCalls?: any[] }> {
    // Set the API key in environment for Google AI SDK
    process.env.GOOGLE_GENERATIVE_AI_API_KEY = "";

    // Define tools for the AI
    const tools = {
        getCalendarAvailability: tool({
            description: 'Get calendar availability for a specified number of days ahead. Use this when user asks about available times, slots, or wants to see the calendar.',
            parameters: z.object({
                daysAhead: z.number().describe('Number of days to check ahead (default: 30)').optional(),
            }),
            execute: async ({ daysAhead = 30 }) => {
                const availability = await getCalendarAvailability(daysAhead);
                return JSON.stringify(availability, null, 2);
            },
        }),
        bookMeeting: tool({
            description: 'Book a meeting slot. Use this when the user wants to schedule or book a meeting. You need the start time (ISO format), attendee email, and attendee name.',
            parameters: z.object({
                startTime: z.string().describe('Start time in ISO format (e.g., "2024-12-07T14:00:00Z")'),
                endTime: z.string().describe('End time in ISO format (e.g., "2024-12-07T14:30:00Z")'),
                attendeeEmail: z.string().email().describe('Email address of the attendee'),
                attendeeName: z.string().describe('Full name of the attendee'),
                notes: z.string().optional().describe('Optional notes for the meeting'),
            }),
            execute: async ({ startTime, endTime, attendeeEmail, attendeeName, notes }) => {
                const result = await bookMeeting(startTime, endTime, attendeeEmail, attendeeName, notes);
                return JSON.stringify(result, null, 2);
            },
        }),
    };

    try {
        const systemPrompt = `You are a helpful calendar assistant with access to calendar scheduling tools.

Current Calendar Status:
${formatAvailabilityForAI(calendar)}

Instructions:
1. Be friendly, helpful, and conversational
2. When users ask about availability, use the getCalendarAvailability tool to fetch current slots
3. When users want to book a meeting, use the bookMeeting tool with the required information
4. Always share the booking link when a meeting is successfully booked
5. If you don't have all the information needed to book (like email or name), ask the user for it
6. When showing availability, mention the booking link so users can book directly if they prefer
7. Keep responses natural and concise
8. If booking succeeds, always prominently display the booking URL in your response`;

        const result = await generateText({
            model: google('gemini-2.5-flash-lite'),
            system: systemPrompt,
            prompt: userMessage,
            tools,
            maxSteps: 5, // Allow multiple tool calls
            maxTokens: 2000,
        });

        // Handle tool calls if any
        if (result.steps && result.steps.length > 0) {
            const lastStep = result.steps[result.steps.length - 1];
            return {
                text: lastStep.text || result.text || "I couldn't generate a response.",
                toolCalls: result.steps.flatMap(step => step.toolCalls || []),
            };
        }

        return {
            text: result.text?.trim() || "I couldn't generate a response.",
        };
    } catch (error: any) {
        return {
            text: `Error generating response: ${error.message}`,
        };
    }
}

/**
 * Interactive bot loop
 */
async function runBot() {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });

    const question = (prompt: string): Promise<string> => {
        return new Promise((resolve) => {
            rl.question(prompt, resolve);
        });
    };

    console.log('\n🤖 Test Bot with Cal.com Tools');
    console.log('='.repeat(50));
    console.log('Type "help" for commands, "quit" to exit\n');

    // Load calendar on startup
    console.log('📅 Loading calendar availability...');
    let calendar = await getCalendarAvailability(30); // Check next 30 days
    
    if (calendar.connected) {
        console.log(`✅ Calendar connected: ${calendar.event_type_name || 'Event'}`);
        console.log(`   Available slots: ${calendar.available_slots.length}`);
        console.log(`   Booking link: ${calendar.booking_link}\n`);
    } else {
        console.log('⚠️  Calendar not connected (using dummy key)\n');
    }

    while (true) {
        const userInput = await question('You: ');

        if (userInput.toLowerCase() === 'quit' || userInput.toLowerCase() === 'exit') {
            console.log('\n👋 Goodbye!');
            break;
        }

        if (userInput.toLowerCase() === 'help') {
            console.log('\n📋 Available Commands:');
            console.log('  help          - Show this help');
            console.log('  calendar      - Show calendar availability');
            console.log('  refresh       - Refresh calendar availability');
            console.log('  book          - Book a meeting (interactive)');
            console.log('  quit/exit     - Exit the bot\n');
            continue;
        }

        if (userInput.toLowerCase() === 'calendar' || userInput.toLowerCase() === 'availability') {
            const calendarContext = formatAvailabilityForAI(calendar);
            console.log(`\n📅 Calendar Status:\n${calendarContext}`);

            // Show detailed slot breakdown
            if (calendar.available_slots.length > 0) {
                console.log('\n📋 Detailed availability:');
                const slotsByDate = calendar.available_slots.reduce((acc, slot) => {
                    if (!acc[slot.date]) acc[slot.date] = [];
                    acc[slot.date].push(slot);
                    return acc;
                }, {} as Record<string, typeof calendar.available_slots>);

                Object.entries(slotsByDate).slice(0, 5).forEach(([date, slots]) => {
                    console.log(`   ${new Date(date).toDateString()}: ${slots.length} slots`);
                });
            }
            console.log('');
            continue;
        }

        if (userInput.toLowerCase() === 'refresh') {
            console.log('\n🔄 Refreshing calendar (checking next 30 days)...');
            calendar = await getCalendarAvailability(30);
            if (calendar.connected) {
                console.log(`✅ Updated: ${calendar.available_slots.length} slots available`);
                if (calendar.available_slots.length > 0) {
                    console.log('   Next slots:');
                    calendar.available_slots.slice(0, 5).forEach((slot, idx) => {
                        console.log(`   ${idx + 1}. ${slot.date} at ${slot.time}`);
                    });
                }
                console.log('');
            } else {
                console.log('⚠️  Calendar not connected\n');
            }
            continue;
        }

        if (userInput.toLowerCase().startsWith('book')) {
            if (!calendar.connected || calendar.available_slots.length === 0) {
                console.log('\n❌ No available slots to book. Try "refresh" first.\n');
                continue;
            }

            console.log('\n📅 Available slots:');
            calendar.available_slots.slice(0, 5).forEach((slot, idx) => {
                console.log(`   ${idx + 1}. ${slot.date} at ${slot.time}`);
            });

            const slotChoice = await question('\nSelect slot number (1-5): ');
            const slotIndex = parseInt(slotChoice) - 1;

            if (isNaN(slotIndex) || slotIndex < 0 || slotIndex >= Math.min(5, calendar.available_slots.length)) {
                console.log('❌ Invalid slot number\n');
                continue;
            }

            const selectedSlot = calendar.available_slots[slotIndex];
            const attendeeEmail = await question('Attendee email: ');
            const attendeeName = await question('Attendee name: ');
            const notes = await question('Notes (optional): ');

            // Use the ISO times from the slot if available, otherwise construct them
            const startTime = selectedSlot.start_iso || new Date(`${selectedSlot.date}T${selectedSlot.time}:00Z`).toISOString();
            const endTime = selectedSlot.end_iso || new Date(new Date(startTime).getTime() + 30 * 60000).toISOString();

            console.log('\n📝 Booking meeting...');
            const bookingResult = await bookMeeting(
                startTime,
                endTime,
                attendeeEmail,
                attendeeName,
                notes || undefined
            );

            if (bookingResult.success) {
                console.log(`✅ Meeting booked successfully!`);
                console.log(`   Booking ID: ${bookingResult.booking_id || 'N/A'}`);
                console.log(`   Booking URL: ${bookingResult.booking_url || 'N/A'}\n`);
            } else {
                console.log(`❌ Booking failed: ${bookingResult.error}\n`);
            }
            continue;
        }

        // Regular conversation with AI (with tool calling)
        process.stdout.write('\n🤖 Bot: ');
        const reply = await generateReplyWithGemini(userInput, calendar);
        
        // Process tool calls and extract booking information
        let bookingUrl: string | null = null;
        if (reply.toolCalls && reply.toolCalls.length > 0) {
            for (const toolCall of reply.toolCalls) {
                if (toolCall.toolName === 'getCalendarAvailability') {
                    // Refresh calendar data after fetching availability
                    calendar = await getCalendarAvailability(30);
                } else if (toolCall.toolName === 'bookMeeting' && toolCall.result) {
                    // Extract booking URL from tool result
                    try {
                        const result = JSON.parse(toolCall.result);
                        if (result.success && result.booking_url) {
                            bookingUrl = result.booking_url;
                        }
                    } catch (e) {
                        // Try to extract URL from text
                        const urlMatch = toolCall.result.match(/https?:\/\/[^\s"']+/);
                        if (urlMatch) {
                            bookingUrl = urlMatch[0];
                        }
                    }
                }
            }
        }
        
        // Display the reply
        console.log(reply.text + '\n');
        
        // Display booking link prominently if booking was successful
        if (bookingUrl) {
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
            console.log(`🔗 BOOKING LINK: ${bookingUrl}`);
            console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
        } else {
            // Try to extract URL from reply text as fallback
            const urlMatch = reply.text.match(/https?:\/\/[^\s\)]+/);
            if (urlMatch && (reply.text.includes('booking') || reply.text.includes('meeting'))) {
                console.log(`\n🔗 Booking Link: ${urlMatch[0]}\n`);
            }
        }
    }

    rl.close();
}

// Run bot
runBot().catch((error) => {
    console.error('❌ Bot error:', error);
    process.exit(1);
});

export { runBot, getCalendarAvailability, bookMeeting, generateReplyWithGemini };
