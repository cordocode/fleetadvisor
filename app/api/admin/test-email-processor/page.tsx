// app/admin/test-email-processor/page.tsx
'use client'

import { useState } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { useRouter } from 'next/navigation'
import { useEffect } from 'react'

export default function TestEmailProcessor() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<any>(null)
  const [error, setError] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [checking, setChecking] = useState(true)
  
  const router = useRouter()
  const supabase = createClientComponentClient()

  useEffect(() => {
    const checkAdmin = async () => {
      const { data: { user } } = await supabase.auth.getUser()
      
      if (!user) {
        router.push('/auth/login')
        return
      }
      
      // Check if user is admin
      const { data: profile } = await supabase
        .from('profiles')
        .select('is_admin')
        .eq('user_id', user.id)
        .single()
      
      if (!profile?.is_admin) {
        router.push('/dashboard')
        return
      }
      
      setIsAdmin(true)
      setChecking(false)
    }
    
    checkAdmin()
  }, [router, supabase])

  const runProcessor = async () => {
    setLoading(true)
    setError(null)
    setResult(null)
    
    try {
      const response = await fetch('/api/cron/process-fleet-emails', {
        method: 'POST' // Using POST for manual trigger
      })
      
      const data = await response.json()
      
      if (response.ok) {
        setResult(data)
      } else {
        setError(data.error || 'Failed to run processor')
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred')
    } finally {
      setLoading(false)
    }
  }
  
  if (checking) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div>Checking permissions...</div>
      </div>
    )
  }
  
  if (!isAdmin) {
    return null
  }

  return (
    <div className="min-h-screen bg-gray-50 py-12">
      <div className="max-w-4xl mx-auto px-4">
        <div className="bg-white rounded-lg shadow-lg p-8">
          <h1 className="text-2xl font-bold text-gray-900 mb-6">
            Fleet Email Processor - Manual Test
          </h1>
          
          <div className="mb-6 p-4 bg-yellow-50 border border-yellow-200 rounded">
            <p className="text-sm text-yellow-800">
              <strong>⚠️ Development Only:</strong> This page allows manual triggering of the email processor for testing.
              In production, the processor runs automatically every 5 minutes via cron job.
            </p>
          </div>
          
          <div className="space-y-4">
            <div>
              <h2 className="text-lg font-semibold mb-2">Process Details:</h2>
              <ul className="list-disc list-inside text-sm text-gray-600 space-y-1">
                <li>Checks inbox at: donotreply@gofleetadvisor.com</li>
                <li>Processes emails with PDF attachments</li>
                <li>Extracts metadata using OpenAI</li>
                <li>Uploads to INVOICE and DOT buckets</li>
                <li>Moves processed emails to Batch_3_sorted label</li>
                <li>Logs results to Google Sheets</li>
              </ul>
            </div>
            
            <button
              onClick={runProcessor}
              disabled={loading}
              className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                loading
                  ? 'bg-gray-300 text-gray-500 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700'
              }`}
            >
              {loading ? 'Processing...' : 'Run Email Processor'}
            </button>
            
            {error && (
              <div className="mt-4 p-4 bg-red-50 border border-red-200 rounded">
                <h3 className="text-sm font-semibold text-red-800 mb-1">Error:</h3>
                <p className="text-sm text-red-700">{error}</p>
              </div>
            )}
            
            {result && (
              <div className="mt-4 p-4 bg-green-50 border border-green-200 rounded">
                <h3 className="text-sm font-semibold text-green-800 mb-2">Success!</h3>
                <div className="text-sm text-green-700">
                  <p>Timestamp: {result.timestamp}</p>
                  {result.results && (
                    <>
                      <p>Processed: {result.results.processed}</p>
                      <p>Failed: {result.results.failed}</p>
                      <p>Skipped: {result.results.skipped}</p>
                    </>
                  )}
                </div>
                <details className="mt-2">
                  <summary className="text-sm text-green-600 cursor-pointer">View Full Response</summary>
                  <pre className="mt-2 text-xs bg-white p-2 rounded overflow-x-auto">
                    {JSON.stringify(result, null, 2)}
                  </pre>
                </details>
              </div>
            )}
          </div>
          
          <div className="mt-8 pt-6 border-t">
            <h3 className="text-sm font-semibold text-gray-700 mb-2">Cron Schedule:</h3>
            <code className="text-xs bg-gray-100 px-2 py-1 rounded">*/5 * * * *</code>
            <p className="text-xs text-gray-500 mt-1">Runs every 5 minutes</p>
          </div>
        </div>
      </div>
    </div>
  )
}