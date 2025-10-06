// app/dashboard/page.tsx
'use client'

import { useEffect, useState } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { useRouter } from 'next/navigation'

interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  files?: Array<{
    url: string
    name: string
    date: string
    invoice?: string
    unit?: string
    vin?: string
    plate?: string
    company?: string
    documentType?: string
    bucket?: string
  }>
}

export default function Dashboard() {
  const [companyDisplayName, setCompanyDisplayName] = useState<string>('')
  const [userId, setUserId] = useState<string>('')
  const [isAdmin, setIsAdmin] = useState(false)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])
  const [conversationId, setConversationId] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const router = useRouter()
  const supabase = createClientComponentClient()

  // Initialize or load conversation
  const initializeConversation = async (uid: string, isAdminUser: boolean) => {
    try {
      const urlParams = new URLSearchParams(window.location.search)
      const existingConvId = urlParams.get('conversation')

      if (existingConvId && isAdminUser) {
        const loadResponse = await fetch('/api/ai/load-conversation', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            conversationId: existingConvId,
            userId: uid,
          }),
        })

        const loadData = await loadResponse.json()
        if (loadData.success && loadData.messages) {
          setConversationId(existingConvId)
          setChatHistory(loadData.messages)
          console.log('Loaded existing conversation:', existingConvId)
          return
        }
      }

      // Create new conversation
      const response = await fetch('/api/ai/new-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: uid }),
      })

      const data = await response.json()
      if (data.success) {
        setConversationId(data.conversationId)
        console.log('Created new conversation:', data.conversationId)

        // Update URL without refresh
        if (isAdminUser) {
          const newUrl = `${window.location.pathname}?conversation=${data.conversationId}`
          window.history.pushState({}, '', newUrl)
        }
      }
    } catch (error) {
      console.error('Error initializing conversation:', error)
    }
  }

  useEffect(() => {
    const checkUser = async () => {
      const { data: { user } } = await supabase.auth.getUser()

      if (!user) {
        router.push('/auth/login')
        return
      }

      setUserId(user.id)

      try {
        const { data: profile } = await supabase
          .from('profiles')
          .select('company_id, is_admin')
          .eq('user_id', user.id)
          .single()

        if (profile?.company_id) {
          const isAdminUser = profile.is_admin || false
          setIsAdmin(isAdminUser)

          const { data: companyData } = await supabase
            .from('companies')
            .select('name')
            .eq('id', profile.company_id)
            .single()

          if (companyData) {
            // Format display name
            let displayName = companyData.name
              .split('-')
              .map((word: string) => word.charAt(0).toUpperCase() + word.slice(1))
              .join(' ')

            if (companyData.name === 'fleet-advisor-ai-admin') {
              displayName = 'Fleet Advisor Admin'
            }

            setCompanyDisplayName(displayName)
          }

          // Initialize conversation
          await initializeConversation(user.id, isAdminUser)
        }
      } catch (error) {
        console.error('Error fetching user data:', error)
      }

      setLoading(false)
    }

    checkUser()
  }, [router, supabase])

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    if (!message.trim() || !conversationId || submitting) return

    const userMessage = message.trim()
    setChatHistory(prev => [...prev, { role: 'user', content: userMessage }])
    setMessage('')
    setSubmitting(true)

    try {
      const response = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: userMessage,
          conversationId,
          userId,
        }),
      })

      const data = await response.json()

      if (data.success) {
        setChatHistory(prev => [
          ...prev,
          {
            role: 'assistant',
            content: data.response,
            files: data.files || []
          },
        ])
      } else {
        setChatHistory(prev => [
          ...prev,
          {
            role: 'assistant',
            content: data.error || 'I encountered an error. Please try again.',
          },
        ])
      }
    } catch (error) {
      console.error('Error in chat:', error)
      setChatHistory(prev => [
        ...prev,
        { role: 'assistant', content: 'I encountered an error. Please try again.' },
      ])
    } finally {
      setSubmitting(false)
    }
  }

  const handleNewConversation = async () => {
    const confirmed = confirm('Start a new conversation? This will clear your current chat.')
    if (!confirmed) return

    try {
      const response = await fetch('/api/ai/new-conversation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId }),
      })

      const data = await response.json()
      if (data.success) {
        setConversationId(data.conversationId)
        setChatHistory([])

        // Update URL
        if (isAdmin) {
          const newUrl = `${window.location.pathname}?conversation=${data.conversationId}`
          window.history.pushState({}, '', newUrl)
        }
      }
    } catch (error) {
      console.error('Error creating new conversation:', error)
    }
  }

  const handleSignOut = async () => {
    await supabase.auth.signOut()
    router.push('/auth/login')
  }

  if (loading) {
    return (
      <div className="flex justify-center items-center h-screen">
        <div className="text-gray-500">Loading...</div>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-screen bg-white">
      {/* Header */}
      <div className="border-b bg-white">
        <div className="max-w-4xl mx-auto px-4 py-3 flex justify-between items-center">
          <div>
            <h1 className="text-xl font-semibold text-gray-900">Fleet Advisor AI</h1>
            <p className="text-sm text-gray-600">
              {isAdmin ? (
                <>
                  Admin Mode - Cross-Company Access
                  <span className="ml-2 text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded">
                    Enhanced AI
                  </span>
                </>
              ) : (
                <>
                  {companyDisplayName}
                  <span className="ml-2 text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded">
                    Company Access
                  </span>
                </>
              )}
            </p>
          </div>
          <div className="flex gap-2">
            {isAdmin && (
              <button
                onClick={handleNewConversation}
                className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-700 bg-white hover:bg-gray-50"
              >
                New Chat
              </button>
            )}
            <button
              onClick={handleSignOut}
              className="px-3 py-1.5 text-sm border border-gray-300 rounded-md text-gray-700 bg-white hover:bg-gray-50"
            >
              Sign Out
            </button>
          </div>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto bg-gray-50">
        <div className="max-w-4xl mx-auto">
          {chatHistory.length === 0 ? (
            <div className="text-center py-20">
              <h2 className="text-2xl font-medium text-gray-900 mb-2">
                Welcome to Fleet Advisor AI
              </h2>
              <p className="text-gray-600 mb-8">
                {isAdmin
                  ? 'Search across all companies with natural language'
                  : `Search for ${companyDisplayName} DOT inspections and invoices`}
              </p>
              <div className="max-w-xl mx-auto text-left space-y-3 text-sm text-gray-600">
                <p className="font-medium text-gray-900">Try asking:</p>
                <ul className="space-y-2">
                  {isAdmin ? (
                    <>
                      <li>• &ldquo;Show me Sturgeon DOT inspections from last week&rdquo;</li>
                      <li>• &ldquo;Find invoices for unit 5678&rdquo;</li>
                      <li>• &ldquo;What&apos;s the access code for Rocky Mountain?&rdquo;</li>
                      <li>• &ldquo;Show me all Enterprise files from October&rdquo;</li>
                    </>
                  ) : (
                    <>
                      <li>• &ldquo;Show me DOT inspections from last week&rdquo;</li>
                      <li>• &ldquo;Find invoice 46270&rdquo;</li>
                      <li>• &ldquo;Show files for unit 112&rdquo;</li>
                      <li>• &ldquo;Get me documents from this month&rdquo;</li>
                    </>
                  )}
                </ul>
              </div>
            </div>
          ) : (
            <div className="py-6 px-4 space-y-4">
              {chatHistory.map((msg, index) => (
                <div key={index} className={`flex gap-3 ${msg.role === 'user' ? 'justify-end' : ''}`}>
                  {msg.role === 'assistant' && (
                    <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-sm font-medium flex-shrink-0">
                      AI
                    </div>
                  )}
                  <div className={`max-w-3xl ${msg.role === 'user' ? 'order-1' : ''}`}>
                    <div
                      className={`rounded-lg px-4 py-3 ${
                        msg.role === 'user'
                          ? 'bg-blue-600 text-white'
                          : 'bg-white border border-gray-200 text-gray-900'
                      }`}
                    >
                      <div className="whitespace-pre-wrap">{msg.content}</div>

                      {/* File Results */}
                      {msg.files && msg.files.length > 0 && (
                        <div className="mt-4 space-y-2">
                          <p className={`text-sm font-medium mb-2 ${msg.role === 'user' ? 'text-white' : 'text-gray-900'}`}>
                            Found {msg.files.length} file{msg.files.length > 1 ? 's' : ''}:
                          </p>
                          {msg.files.map((file, fileIndex) => (
                            <a
                              key={fileIndex}
                              href={file.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block p-3 bg-gray-50 rounded border border-gray-200 hover:bg-gray-100 transition-colors"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex-1">
                                  <div className="flex items-center gap-2">
                                    <span
                                      className={`text-xs font-medium px-2 py-0.5 rounded ${
                                        file.documentType === 'DOT Inspection'
                                          ? 'bg-green-100 text-green-700'
                                          : 'bg-blue-100 text-blue-700'
                                      }`}
                                    >
                                      {file.documentType || 'Document'}
                                    </span>
                                    <span className="text-sm font-medium text-gray-900">
                                      {file.date}
                                    </span>
                                  </div>
                                  <div className="text-xs text-gray-600 mt-1">
                                    {isAdmin && file.company && (
                                      <span className="font-medium">{file.company} • </span>
                                    )}
                                    {file.invoice && file.invoice !== 'NA' && (
                                      <span>Invoice: {file.invoice} • </span>
                                    )}
                                    {file.unit && file.unit !== 'NA' && (
                                      <span>Unit: {file.unit} • </span>
                                    )}
                                    {file.plate && file.plate !== 'NA' && (
                                      <span>Plate: {file.plate}</span>
                                    )}
                                  </div>
                                </div>
                                <svg
                                  className="w-5 h-5 text-gray-400"
                                  fill="none"
                                  stroke="currentColor"
                                  viewBox="0 0 24 24"
                                >
                                  <path
                                    strokeLinecap="round"
                                    strokeLinejoin="round"
                                    strokeWidth={2}
                                    d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14"
                                  />
                                </svg>
                              </div>
                            </a>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                  {msg.role === 'user' && (
                    <div className="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center text-white text-sm font-medium flex-shrink-0 order-2">
                      {companyDisplayName.charAt(0)}
                    </div>
                  )}
                </div>
              ))}

              {/* Thinking indicator */}
              {submitting && (
                <div className="flex gap-3">
                  <div className="w-8 h-8 rounded-full bg-blue-500 flex items-center justify-center text-white text-sm font-medium">
                    AI
                  </div>
                  <div className="bg-white border border-gray-200 rounded-lg px-4 py-3">
                    <div className="flex items-center gap-2">
                      <div className="flex gap-1">
                        <div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" />
                        <div
                          className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                          style={{ animationDelay: '0.1s' }}
                        />
                        <div
                          className="w-2 h-2 bg-gray-400 rounded-full animate-bounce"
                          style={{ animationDelay: '0.2s' }}
                        />
                      </div>
                      <span className="text-sm text-gray-500">Working...</span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Input Area */}
      <div className="border-t bg-white">
        <form onSubmit={handleSubmit} className="max-w-4xl mx-auto p-4">
          <div className="flex gap-3">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                isAdmin
                  ? 'Ask me anything about fleet documents...'
                  : 'What can I find for you?'
              }
              className="flex-1 px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              autoFocus
              disabled={submitting}
            />
            <button
              type="submit"
              disabled={!message.trim() || submitting}
              className={`px-6 py-3 rounded-lg font-medium transition-colors ${
                message.trim() && !submitting
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'bg-gray-100 text-gray-400 cursor-not-allowed'
              }`}
            >
              Send
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}