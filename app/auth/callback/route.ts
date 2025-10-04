// app/auth/callback/route.ts
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  console.log('=== AUTH CALLBACK HIT ===');
  
  const requestUrl = new URL(request.url);
  const token_hash = requestUrl.searchParams.get('token_hash');
  const type = requestUrl.searchParams.get('type');
  const code = requestUrl.searchParams.get('code');
  
  console.log('Full URL:', request.url);
  console.log('All params:', { 
    token_hash: token_hash ? `${token_hash.substring(0, 12)}...` : 'none', 
    type: type,
    code: 'none'
  });

  // CRITICAL: Use createRouteHandlerClient for proper cookie handling
  const supabase = createRouteHandlerClient({ cookies });

  // Handle password recovery
  if (type === 'recovery' && token_hash) {
    console.log('RECOVERY TYPE DETECTED');
    
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash,
        type: 'recovery',
      });

      console.log('Recovery verification complete:');
      console.log('Error:', error);
      console.log('Has session:', !!data?.session);
      console.log('Has user:', !!data?.user);

      if (error) {
        console.error('Recovery failed with error:', error.message);
        
        if (error.message?.includes('expired') || error.code === 'otp_expired') {
          return NextResponse.redirect(
            new URL('/auth/forgot-password?error=expired', requestUrl.origin)
          );
        }
        
        return NextResponse.redirect(
          new URL(`/auth/forgot-password?error=${encodeURIComponent(error.message)}`, requestUrl.origin)
        );
      }

      // Success - the session should now be set in cookies
      console.log('SUCCESS! Session created, redirecting to reset-password page');
      
      // IMPORTANT: The session is now stored in cookies by createRouteHandlerClient
      return NextResponse.redirect(
        new URL('/auth/reset-password', requestUrl.origin)
      );
      
    } catch (err) {
      console.error('Unexpected error during recovery:', err);
      return NextResponse.redirect(
        new URL('/auth/forgot-password?error=unexpected_error', requestUrl.origin)
      );
    }
  }

  // Handle email verification (your existing signup code)
  if (token_hash && type && type !== 'recovery') {
    console.log('Attempting email verification with type:', type);
    
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash,
        type: type as 'signup' | 'invite' | 'email',
      });

      console.log('Verification result:', {
        success: !error,
        error: error?.message,
        userData: data?.user?.email
      });

      if (!error && data?.user) {
        console.log('Verification successful!');
        
        // Check if profile exists
        const { data: profile } = await supabase
          .from('profiles')
          .select('*')
          .eq('user_id', data.user.id)
          .single();
        
        console.log('Profile exists:', !!profile);
        
        return NextResponse.redirect(
          new URL('/auth/login?verified=true', requestUrl.origin)
        );
      } else {
        console.error('Verification failed:', error);
        return NextResponse.redirect(
          new URL('/auth/login?error=verification_failed&message=' + encodeURIComponent(error?.message || 'Unknown error'), requestUrl.origin)
        );
      }
    } catch (error) {
      console.error('Unexpected error during verification:', error);
      return NextResponse.redirect(
        new URL('/auth/login?error=unexpected_error', requestUrl.origin)
      );
    }
  }

  // Handle OAuth code exchange
  if (code) {
    console.log('Handling OAuth code exchange...');
    try {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (error) throw error;
      return NextResponse.redirect(new URL('/dashboard', requestUrl.origin));
    } catch (error) {
      console.error('Error exchanging code for session:', error);
      return NextResponse.redirect(
        new URL('/auth/login?error=oauth_error', requestUrl.origin)
      );
    }
  }

  // No valid params found
  console.log('No valid params found, redirecting to login');
  return NextResponse.redirect(new URL('/auth/login', requestUrl.origin));
}