import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export async function GET(request: NextRequest) {
  console.log('=== AUTH CALLBACK HIT ===');
  
  const requestUrl = new URL(request.url);
  const token_hash = requestUrl.searchParams.get('token_hash');
  const type = requestUrl.searchParams.get('type');
  const code = requestUrl.searchParams.get('code');
  
  console.log('Params received:', {
    token_hash: token_hash ? `${token_hash.substring(0, 10)}...` : 'none',
    type,
    code: code ? 'present' : 'none',
    fullUrl: request.url
  });

  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY! // Use ANON key for auth operations
  );

  // Handle email verification
  if (token_hash && type) {
    console.log('Attempting email verification...');
    
    try {
      const { data, error } = await supabase.auth.verifyOtp({
        token_hash,
        type: type as 'signup' | 'recovery' | 'invite' | 'email',
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
        
        // Redirect to login with success message
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

  // Handle OAuth code exchange (if using social logins)
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

  // If neither token_hash nor code, redirect to login
  console.log('No token_hash or code found, redirecting to login');
  return NextResponse.redirect(new URL('/auth/login?error=missing_params', requestUrl.origin));
}