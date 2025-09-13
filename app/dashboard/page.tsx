'use client'

import { useEffect, useState } from 'react'
import { createClientComponentClient } from '@supabase/auth-helpers-nextjs'
import { useRouter } from 'next/navigation'
import { User } from '@supabase/supabase-js'

interface ChatMessage {
  role: string;
  content: string;
  files?: Array<{
    url: string;
    name: string;
    date: string;
  }>;
}

export default function Dashboard() {
  const [company, setCompany] = useState<string>('')
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([])

  const router = useRouter()
  const supabase = createClientComponentClient()

  useEffect(() => {
    const checkUser = async () => {
      const {
        data: { user },
      } = await supabase.auth.getUser()

      if (!user) {
        router.push('/auth/login')
        return
      }

      try {
        const { data: profile, error: profileError } = await supabase
          .from('profiles')
          .select('company_id')
          .eq('user_id', user.id)
          .single()

        console.log('Profile fetch:', { profile, profileError })

        if (profile?.company_id) {
          const { data: companyData, error: companyError } = await supabase
            .from('companies')
            .select('name')
            .eq('id', profile.company_id)
            .single()

          console.log('Company fetch:', { companyData, companyError })

          if (companyData) {
            setCompany(companyData.name)
          }
        }
      } catch (error) {
        console.error('Error fetching company:', error)
      }

      setLoading(false)
    }

    checkUser()
  }, [router, supabase])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!message.trim()) return

    const userMessage = message
    setChatHistory((prev) => [...prev, { role: 'user', content: userMessage }])
    setMessage('')

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

      if (!parseData.success || parseData.unitNumber === 'NOT_FOUND') {
        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content:
              'I could not find a unit number in your request. Please specify a unit number, like "unit 112" or "truck 45".',
          },
        ])
        return
      }

      const retrieveResponse = await fetch('/api/retrieve-files', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          company: company,
          unitNumber: parseData.unitNumber,
        }),
      })

      const retrieveData = await retrieveResponse.json()

      if (retrieveData.success && retrieveData.count > 0) {
        const latestFile = retrieveData.files[0]
        const responseText = `Found ${retrieveData.count} inspection(s) for Unit ${parseData.unitNumber}.\n\nMost recent inspection: ${latestFile.date}`

        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: responseText,
            files: retrieveData.files,
          },
        ])
      } else {
        setChatHistory((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `No inspections found for Unit ${parseData.unitNumber} in ${company}.`,
          },
        ])
      }
    } catch (error) {
      console.error('Error:', error)
      setChatHistory((prev) => [
        ...prev,
        { role: 'assistant', content: 'An error occurred. Please try again.' },
      ])
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
            <h1 className="text-lg font-semibold">DOT Retrieval</h1>
            {company && (
              <p className="text-sm text-gray-600">Company: {company}</p>
            )}
          </div>
          <button
            onClick={() => supabase.auth.signOut()}
            className="text-sm text-gray-600 hover:text-gray-900"
          >
            Sign Out
          </button>
        </div>
      </div>

      {/* Chat Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto">
          {chatHistory.length === 0 ? (
            <div className="text-center text-gray-500 mt-32">
              <h2 className="text-2xl font-normal mb-2">
                DOT Inspection Retrieval
              </h2>
              <p>Ask me to find inspection reports.</p>
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
                                    DOT Inspection - {file.date}
                                  </p>
                                  <p className="text-xs text-gray-600 mt-1">
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
            </div>
          )}
        </div>
      </div>

      {/* Input Area */}
      <div className="border-t">
        <form onSubmit={handleSubmit} className="max-w-3xl mx-auto px-4 py-4">
          <div className="relative">
            <input
              type="text"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Message DOT Retrieval..."
              className="w-full px-4 py-3 pr-12 border border-gray-300 rounded-lg focus:outline-none focus:border-gray-400 resize-none"
              autoFocus
            />
            <button
              type="submit"
              disabled={!message.trim()}
              className={`absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-md ${
                message.trim()
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