'use client';

import { useState, useEffect } from 'react';
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs';
import { useRouter } from 'next/navigation';

export default function ResetPasswordPage() {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [userEmail, setUserEmail] = useState<string | null>(null);
  
  const router = useRouter();
  const supabase = createClientComponentClient();

  useEffect(() => {
    // Check if user has a valid recovery session
    const checkRecoverySession = async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        
        console.log('Recovery session check:', {
          hasSession: !!session,
          userEmail: session?.user?.email,
        });

        if (!session) {
          // No recovery session, redirect to forgot password
          console.log('No recovery session found, redirecting...');
          router.push('/auth/forgot-password?error=no_recovery_session');
          return;
        }

        // Store user email for display
        setUserEmail(session.user.email || null);
        setCheckingSession(false);
      } catch (err) {
        console.error('Error checking recovery session:', err);
        router.push('/auth/forgot-password?error=session_error');
      }
    };

    checkRecoverySession();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [router]); // keep dependencies simple to avoid re-runs

  const validatePasswords = (): boolean => {
    if (password.length < 6) {
      setError('Password must be at least 6 characters long');
      return false;
    }
    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return false;
    }
    return true;
  };

  const handleResetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!validatePasswords()) return;
    setLoading(true);

    try {
      // Update the user's password
      const { error: updateError } = await supabase.auth.updateUser({
        password: password
      });

      if (updateError) {
        console.error('Password update error:', updateError);
        setError(updateError.message);
        setLoading(false);
        return;
      }

      console.log('Password updated successfully!');
      await supabase.auth.signOut();
      router.push('/auth/login?password_reset=true');
    } catch (err) {
      console.error('Unexpected error:', err);
      setError('An unexpected error occurred. Please try again.');
      setLoading(false);
    }
  };

  // Show loading state while checking session
  if (checkingSession) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-gray-500">Verifying recovery session...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full space-y-8">
        <div>
          <h1 className="text-center text-4xl font-bold text-gray-900 mb-2">
            Fleet Advisor
          </h1>
          <h2 className="mt-6 text-center text-3xl font-extrabold text-gray-900">
            Set your new password
          </h2>
          {userEmail && (
            <p className="mt-2 text-center text-sm text-gray-600">
              for {userEmail}
            </p>
          )}
        </div>

        <form className="mt-8 space-y-6" onSubmit={handleResetPassword}>
          <div className="space-y-4">
            <div>
              <label htmlFor="password" className="block text-sm font-medium text-gray-700">
                New Password
              </label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete="new-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Enter new password"
                minLength={6}
              />
              <p className="mt-1 text-xs text-gray-500">
                Must be at least 6 characters
              </p>
            </div>

            <div>
              <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700">
                Confirm New Password
              </label>
              <input
                id="confirmPassword"
                name="confirmPassword"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                className="mt-1 appearance-none relative block w-full px-3 py-2 border border-gray-300 placeholder-gray-500 text-gray-900 rounded-md focus:outline-none focus:ring-indigo-500 focus:border-indigo-500 focus:z-10 sm:text-sm"
                placeholder="Confirm new password"
                minLength={6}
              />
            </div>
          </div>

          {error && (
            <div className="rounded-md bg-red-50 p-4">
              <div className="text-sm text-red-800">{error}</div>
            </div>
          )}

          <div>
            <button
              type="submit"
              disabled={loading || !password || !confirmPassword}
              className="group relative w-full flex justify-center py-2 px-4 border border-transparent text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              {loading ? 'Updating password...' : 'Reset password'}
            </button>
          </div>

          <div className="text-center">
            <a
              href="/auth/login"
              className="text-sm text-gray-600 hover:text-gray-500"
            >
              ← Back to sign in
            </a>
          </div>
        </form>
      </div>
    </div>
  );
}
