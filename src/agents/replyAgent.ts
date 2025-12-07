/**
 * AI Reply Agent using Vercel AI SDK + Gemini 2.0 Flash
 * Simple reply generation - no tool calling for now
 */
import { generateText } from 'ai';
import { google } from '@ai-sdk/google';

export interface EmailContext {
    originalSubject: string;
    contactEmail: string;
    contactName?: string;
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
}

// System default prompt - used when no custom prompt is provided
const DEFAULT_PROMPT = `You are a professional sales representative. Your goal is to engage with prospects, understand their needs, and guide conversations toward scheduling meetings.

Instructions:
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
}

/**
 * Generate an AI-powered reply using Gemini 2.0 Flash
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

        // Build the full prompt with context
        const prompt = `${basePrompt}

Context: ${context.campaignContext || 'Business outreach'}

Previous conversation:
${historyText || 'No previous messages.'}

Latest email from ${context.contactName || context.contactEmail}:
Subject: ${context.replySubject}
Message: ${context.replyBody}

Reply:`;

        const result = await generateText({
            model: google('gemini-2.5-flash-lite', { apiKey }),
            prompt,
            maxTokens: 600,
        });

        const responseText = result.text?.trim() || '';
        
        // Detect sentiment from the original email (for logging/analytics only)
        const sentiment = quickSentimentCheck(context.replyBody);

        // Always reply - our job is to try
        return {
            subject: `Re: ${context.replySubject.replace(/^Re:\s*/i, '')}`,
            body: responseText,
            shouldReply: true,
            sentiment,
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
