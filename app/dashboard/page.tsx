'use client'

import { useEffect, useState } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { useRouter } from 'next/navigation'

interface ChatMessage {
  role: string;
  content: string;
  files?: Array<{
    url: string;
    name: string;
    date: string;
    invoice?: string;
    unit?: string;
    plate?: string;
    company?: string;
    documentType?: string;
  }>;
  metadata?: any;
}

export default function Dashboard() {
  const [company, setCompany] = useState<string>('')
  const [companyDisplayName, setCompanyDisplayName] = useState<string>('')
  const [userId, setUserId] = useState<string>('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [awaitingConfirmation, setAwaitingConfirmation] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const router = useRouter()
  const supabase = createClientComponentClient()

  // Initialize conversation for admin users
  const initializeAdminConversation = async (uid: string) => {
    try {
      // Create new conversation
      const response = await fetch('/api/admin/new-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid })
      })
      
      const data = await response.json()
      
      if (data.success) {
        setConversationId(data.conversationId)
        console.log('Created new admin conversation:', data.conversationId)
      }
    } catch (error) {
      console.error('Error initializing admin conversation:', error)
    }
  }

  useEffect(() => {
    const checkUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        router.push('/auth/login')
        return
      }

      setUserId(user.id)

      try {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('company_id, is_admin')
          .eq('user_id', user.id)
          .single()

        console.log('Profile fetch:', { profile, profileError })

        if (profile?.company_id) {
          const isAdminUser = profile.is_admin || false
          setIsAdmin(isAdminUser)

          const { data: companyData, error: companyError } = await supabase
            .from('companies')
            .select('name')
            .eq('id', profile.company_id)
            .single()

          console.log('Company fetch:', { companyData, companyError })

          if (companyData) {
            setCompany(companyData.name)

            let displayName = companyData.name
              .split('-')
              .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ')

            if (companyData.name === 'fleet-advisor-ai-admin') {
              displayName = 'Fleet Advisor Admin'
            }

            setCompanyDisplayName(displayName)
          }
          
          // Initialize conversation for admin users
          if (isAdminUser) {
            await initializeAdminConversation(user.id)
          }
        }
      } catch (error) {
        console.error('Error fetching company:', error)
      }

      setLoading(false)
    }

    checkUser()
  }, [router, supabase])

  const handleAdminSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!message.trim() || !conversationId || submitting) return

    const userMessage = message
    setChatHistory((prev) => [...prev, { role: 'user', content: userMessage }])
    setMessage('')
    setSubmitting(true)

    try {
      const response = await fetch('/api/admin/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          conversationId: conversationId,
          userId: userId
        })
      })

      const data = await response.json()

      if (data.success) {
        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: data.response,
            files: data.files || [],
            metadata: data
          }
        ])
        
        // Update confirmation state
        setAwaitingConfirmation(data.awaitingConfirmation || false)
      } else {
        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: 'An error occurred. Please try again.'
          }
        ])
      }
    } catch (error) {
      console.error('Error in admin chat:', error)
      setChatHistory((prev) => [
        ...prev,
        { role: 'assistant', content: 'An error occurred. Please try again.' }
      ])
    } finally {
      setSubmitting(false)
    }
  }

  const handleRegularSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!message.trim() || submitting) return

    const userMessage = message
    setChatHistory((prev) => [...prev, { role: 'user', content: userMessage }])
    setMessage('')
    setSubmitting(true)

    try {
      const parseResponse = await fetch('/api/parse-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          company: company,
        }),
      })

      const parseData = await parseResponse.json()

      if (parseData.searchParams?.ambiguous) {
        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `I found "${parseData.searchParams.ambiguousValue}" in your request. Could you clarify what this is?\n\nIs this:\n• A unit number? (say "unit ${parseData.searchParams.ambiguousValue}")\n• An invoice number? (say "invoice ${parseData.searchParams.ambiguousValue}")\n• A vehicle plate? (say "plate ${parseData.searchParams.ambiguousValue}")\n• A VIN? (say "VIN ${parseData.searchParams.ambiguousValue}")`,
          },
        ])
        setSubmitting(false)
        return
      }

      if (
        !parseData.success ||
        (!parseData.searchParams?.unit &&
          !parseData.searchParams?.invoice &&
          !parseData.searchParams?.vin &&
          !parseData.searchParams?.plate)
      ) {
        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content:
              'I could not find any searchable information in your request. Please specify:\n• A unit number (e.g., "unit 112")\n• An invoice number (e.g., "invoice 46270")\n• A VIN number\n• A plate number',
          },
        ])
        setSubmitting(false)
        return
      }

      const retrieveResponse = await fetch('/api/retrieve-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: company,
          unitNumber: parseData.unitNumber,
          searchParams: parseData.searchParams,
          userId: userId,
        }),
      })

      const retrieveData = await retrieveResponse.json()

      if (retrieveData.success && retrieveData.count > 0) {
        const searchInfo = parseData.searchParams
        let searchDescription = ''

        if (searchInfo.unit) searchDescription = `Unit ${searchInfo.unit}`
        else if (searchInfo.invoice) searchDescription = `Invoice ${searchInfo.invoice}`
        else if (searchInfo.vin) searchDescription = `VIN ${searchInfo.vin}`
        else if (searchInfo.plate) searchDescription = `Plate ${searchInfo.plate}`

        const responseText = `Found ${retrieveData.count} file(s) for ${searchDescription}.${retrieveData.count > 1 ? '\n\nShowing all matches:' : ''}`

        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: responseText,
            files: retrieveData.files,
          },
        ])
      } else {
        const searchInfo = parseData.searchParams
        let searchDescription = ''

        if (searchInfo.unit) searchDescription = `Unit ${searchInfo.unit}`
        else if (searchInfo.invoice) searchDescription = `Invoice ${searchInfo.invoice}`
        else if (searchInfo.vin) searchDescription = `VIN ${searchInfo.vin}`
        else if (searchInfo.plate) searchDescription = `Plate ${searchInfo.plate}`

        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `No files found for ${searchDescription} in ${companyDisplayName}.`,
          },
        ])
      }
    } catch (error) {
      console.error('Error:', error)
      setChatHistory((prev) => [
        ...prev,
        { role: 'assistant', content: 'An error occurred. Please try again.' },
      ])
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmit = isAdmin ? handleAdminSubmit : handleRegularSubmit

  const handleNewConversation = async () => {
    if (!isAdmin) return
    
    const confirmed = confirm('Start a new conversation? This will clear your current chat.')
    if (!confirmed) return
    
    try {
      const response = await fetch('/api/admin/new-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId })
      })
      
      const data = await response.json()
      
      if (data.success) {
        setConversationId(data.conversationId)
        setChatHistory([])
        setAwaitingConfirmation(false)
      }
    } catch (error) {
      console.error('Error creating new conversation:', error)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">Loading...</div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Header */}
      <div className="border-b">
        <div className="max-w-3xl mx-auto px-4 py-3 flex justify-between items-center">
          <div>
            <h1 className="text-lg font-semibold">Fleet Advisor AI</h1>
            {company && (
              <p className="text-sm text-gray-600">
                {isAdmin ? (
                  <>
                    Admin Access - All Companies
                    <span className="ml-2 text-xs text-blue-600">
                      (Enhanced AI with Memory)
                    </span>
                  </>
                ) : (
                  companyDisplayName
                )}
              </p>
            )}
          </div>
          <div className="flex gap-2">
            {isAdmin && (
              <button
                onClick={handleNewConversation}
                className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
              >
                New Chat
              </button>
            )}
            <button
              onClick={async () => {
                await supabase.auth.signOut()
                router.push('/auth/login')
              }}
              className="px-4 py-2 border border-gray-300 text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto">
          {chatHistory.length === 0 ? (
            <div className="text-center text-gray-500 mt-32">
              <h2 className="text-2xl font-normal mb-2">
                Welcome, {companyDisplayName}
              </h2>
              <p>
                {isAdmin
                  ? 'Search across all companies with natural language queries'
                  : 'Search for DOT inspections and invoices'}
              </p>
              {isAdmin && (
                <div className="mt-6 text-sm text-gray-400 max-w-md mx-auto">
                  <p className="font-medium mb-2">Try asking:</p>
                  <ul className="text-left space-y-1">
                    <li>• "All Sturgeon DOTs from last week"</li>
                    <li>• "Show me invoices for unit 112"</li>
                    <li>• "Rocky Mountain files from September"</li>
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="py-8 px-4">
              {chatHistory.map((msg, index) => (
                <div key={index} className="mb-6">
                  <div className="flex gap-3">
                    <div
                      className={`w-8 h-8 rounded-sm flex-shrink-0 flex items-center justify-center text-white text-sm ${
                        msg.role === 'user' ? 'bg-purple-600' : 'bg-green-600'
                      }`}
                    >
                      {msg.role === 'user' ? 'U' : 'A'}
                    </div>
                    <div className="flex-1 pt-1">
                      <div className="text-gray-900 whitespace-pre-wrap">
                        {msg.content}
                      </div>
                      {msg.files && msg.files.length > 0 && (
                        <div className="mt-3 space-y-2">
                          {msg.files.map((file, fileIndex) => (
                            <a
                              key={fileIndex}
                              href={file.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block p-3 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors"
                            >
                              <div className="flex items-center justify-between">
                                <div>
                                  <p className="text-sm font-medium text-blue-900">
                                    {file.documentType || 'DOT Inspection'} - {file.date}
                                  </p>
                                  <p className="text-xs text-gray-600 mt-1">
                                    {isAdmin && file.company && (
                                      <span className="font-medium">
                                        Company: {file.company} |{' '}
                                      </span>
                                    )}
                                    {file.invoice && (
                                      <span>Invoice: {file.invoice} | </span>
                                    )}
                                    {file.unit && file.unit !== 'NA' && (
                                      <span>Unit: {file.unit} | </span>
                                    )}
                                    {file.plate && file.plate !== 'NA' && (
                                      <span>Plate: {file.plate}</span>
                                    )}
                                  </p>
                                  <p className="text-xs text-gray-500 mt-1">
                                    {file.name}
                                  </p>
                                </div>
                                <svg
                                  className="w-5 h-5 text-blue-600"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z"
                                  />
                                </svg>
                              </div>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {submitting && (
                <div className="mb-6">
                  <div className="flex gap-3">
                    <div className="w-8 h-8 rounded-sm flex-shrink-0 flex items-center justify-center text-white text-sm bg-green-600">
                      A
                    </div>
                    <div className="flex-1 pt-1">
                      <div className="text-gray-400">Thinking...</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Input Area */}
      <div className="border-t">
        <form
          onSubmit={handleSubmit}
          className="max-w-3xl mx-auto px-4 py-4"
        >
          <div className="relative">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                isAdmin
                  ? "Ask me anything about your fleet files..."
                  : "What file can I find for you?"
              }
              className="w-full px-4 py-3 pr-12 border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400 resize-none"
              autoFocus
              disabled={submitting}
            />
            <button
              type="submit"
              disabled={!message.trim() || submitting}
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-md ${
                message.trim() && !submitting
                  ? 'text-gray-900 hover:bg-gray-100'
                  : 'text-gray-300'
              }`}
            >
              <svg
                className="w-5 h-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8"
                />
              </svg>
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}