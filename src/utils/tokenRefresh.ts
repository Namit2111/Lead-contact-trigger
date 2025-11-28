/**
 * Lightweight token refresh using raw fetch API
 * No heavy googleapis dependency!
 */

export interface TokenInfo {
    accessToken: string;
    refreshToken?: string;
    tokenExpiry?: string;
}

export interface RefreshedToken {
    access_token: string;
    expiry_date: number;
}

/**
 * Check if a token is expired or will expire soon
 */
export function isTokenExpired(tokenExpiry?: string, bufferMinutes: number = 5): boolean {
    if (!tokenExpiry) {
        return false; // If no expiry provided, assume it's valid
    }

    const expiryDate = new Date(tokenExpiry);
    const now = new Date();
    const bufferMs = bufferMinutes * 60 * 1000;

    // Check if token is expired or will expire within buffer time
    return now >= new Date(expiryDate.getTime() - bufferMs);
}

/**
 * Refresh Google OAuth token using refresh token (using fetch, not googleapis)
 */
export async function refreshGoogleToken(
    refreshToken: string,
    clientId: string,
    clientSecret: string
): Promise<RefreshedToken> {
    try {
        const response = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                client_id: clientId,
                client_secret: clientSecret,
                refresh_token: refreshToken,
                grant_type: 'refresh_token',
            }),
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData?.error_description || errorData?.error || response.statusText);
        }

        const data = await response.json();

        if (!data.access_token) {
            throw new Error('No access token received');
        }

        return {
            access_token: data.access_token,
            // expires_in is in seconds, convert to timestamp
            expiry_date: Date.now() + (data.expires_in || 3600) * 1000,
        };
    } catch (error: any) {
        console.error('Error refreshing token:', error.message);
        throw new Error(`Token refresh failed: ${error.message}`);
    }
}

/**
 * Get a valid access token, refreshing if necessary
 */
export async function getValidAccessToken(
    tokenInfo: TokenInfo,
    clientId: string,
    clientSecret: string
): Promise<{ token: string; expiry: string }> {
    // Check if token needs refresh
    if (isTokenExpired(tokenInfo.tokenExpiry) && tokenInfo.refreshToken) {
        console.log('Token expired or expiring soon, refreshing...');

        const refreshed = await refreshGoogleToken(
            tokenInfo.refreshToken,
            clientId,
            clientSecret
        );

        return {
            token: refreshed.access_token,
            expiry: new Date(refreshed.expiry_date).toISOString(),
        };
    }

    // Token is still valid
    return {
        token: tokenInfo.accessToken,
        expiry: tokenInfo.tokenExpiry || new Date(Date.now() + 3600000).toISOString(),
    };
}
