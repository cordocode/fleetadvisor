import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const CONFIRMATION_THRESHOLD = 10

interface ConversationMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  metadata?: Record<string, unknown>
}

export async function POST(request: Request) {
  try {
    const { message, conversationId, userId } = await request.json()
    
    console.log('=== ADMIN CHAT REQUEST ===')
    console.log('Message:', message)
    console.log('ConversationId:', conversationId)
    console.log('UserId:', userId)
    
    // Get base URL from request headers (works in Vercel)
    const host = request.headers.get('host') || 'localhost:3000'
    const protocol = host.includes('localhost') ? 'http' : 'https'
    const baseUrl = `${protocol}://${host}`
    
    console.log('Using base URL:', baseUrl)
    
    // Verify user is admin
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('user_id', userId)
      .single()
    
    if (!profile?.is_admin) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized: Admin access required' },
        { status: 403 }
      )
    }
    
    console.log('Admin verified')
    
    // Store user message in database
    await supabase
      .from('admin_conversations')
      .insert({
        user_id: userId,
        conversation_id: conversationId,
        message_role: 'user',
        message_content: message,
        message_metadata: {}
      })
    
    // Load conversation history (last 10 messages for context)
    const { data: history } = await supabase
      .from('admin_conversations')
      .select('message_role, message_content, message_metadata')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .limit(10)
    
    const conversationHistory: ConversationMessage[] = (history || []).map(msg => ({
      role: msg.message_role as 'user' | 'assistant' | 'system',
      content: msg.message_content,
      metadata: msg.message_metadata
    }))
    
    console.log('Conversation history loaded:', conversationHistory.length, 'messages')
    
    // Check if this is a confirmation response
    const lastAssistantMessage = conversationHistory
      .filter(m => m.role === 'assistant')
      .pop()
    
    if (lastAssistantMessage) {
      console.log('Last assistant message:', lastAssistantMessage.content.substring(0, 50))
    }
    
    const isConfirmation = lastAssistantMessage?.metadata?.awaitingConfirmation === true
    const isPositiveResponse = /^(yes|y|sure|ok|okay|yep|yeah|confirm|proceed|show them|show all)/i.test(message.trim())
    
    console.log('Is confirmation?', isConfirmation)
    console.log('Is positive response?', isPositiveResponse)
    
    if (isConfirmation && isPositiveResponse) {
      // User confirmed - retrieve and return the files
      console.log('User confirmed - retrieving files')
      
      const metadata = lastAssistantMessage?.metadata || {}
      const originalSearchParams = metadata.searchParams as Record<string, unknown> | undefined
      
      console.log('Original search params:', originalSearchParams)
      
      if (!originalSearchParams) {
        console.error('No search params found in metadata')
        const errorResponse = "I couldn't find the original search parameters. Please try your search again."
        
        await supabase
          .from('admin_conversations')
          .insert({
            user_id: userId,
            conversation_id: conversationId,
            message_role: 'assistant',
            message_content: errorResponse,
            message_metadata: { error: true }
          })
        
        return NextResponse.json({
          success: true,
          response: errorResponse,
          files: [],
          conversationId
        })
      }
      
      // Retrieve files
      const retrieveResponse = await fetch(
        `${baseUrl}/api/admin/retrieve-files`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            searchParams: originalSearchParams,
            userId: userId
          })
        }
      )
      
      const retrieveData = await retrieveResponse.json()
      console.log('Retrieve data:', { success: retrieveData.success, count: retrieveData.count })
      
      if (retrieveData.success) {
        const naturalSummary = (originalSearchParams.naturalLanguageSummary as string) || 'your search'
        const responseText = `Here are all ${retrieveData.count} files:\n\n${naturalSummary}`
        
        // Store assistant response
        await supabase
          .from('admin_conversations')
          .insert({
            user_id: userId,
            conversation_id: conversationId,
            message_role: 'assistant',
            message_content: responseText,
            message_metadata: {
              files: retrieveData.files,
              searchParams: originalSearchParams,
              confirmed: true
            }
          })
        
        return NextResponse.json({
          success: true,
          response: responseText,
          files: retrieveData.files,
          conversationId
        })
      }
    } else if (isConfirmation && !isPositiveResponse) {
      // User declined - acknowledge
      console.log('User declined confirmation')
      const responseText = "No problem! Feel free to refine your search or ask me something else."
      
      await supabase
        .from('admin_conversations')
        .insert({
          user_id: userId,
          conversation_id: conversationId,
          message_role: 'assistant',
          message_content: responseText,
          message_metadata: { declined: true }
        })
      
      return NextResponse.json({
        success: true,
        response: responseText,
        files: [],
        conversationId
      })
    }
    
    // This is a new query - parse it
    console.log('New query - parsing request')
    const parseResponse = await fetch(
      `${baseUrl}/api/admin/parse-request`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message })
      }
    )
    
    const parseData = await parseResponse.json()
    console.log('Parse response:', parseData)
    
    if (!parseData.success) {
      const errorResponse = "I had trouble understanding your request. Could you please rephrase it?"
      
      await supabase
        .from('admin_conversations')
        .insert({
          user_id: userId,
          conversation_id: conversationId,
          message_role: 'assistant',
          message_content: errorResponse,
          message_metadata: { error: true }
        })
      
      return NextResponse.json({
        success: true,
        response: errorResponse,
        files: [],
        conversationId
      })
    }
    
    const searchParams = parseData.searchParams
    
    // Check if we have any search criteria
    const hasSearchCriteria = 
      searchParams.company || 
      searchParams.unit || 
      searchParams.invoice || 
      searchParams.vin || 
      searchParams.plate || 
      searchParams.dateRange
    
    console.log('Has search criteria?', hasSearchCriteria)
    console.log('Search params:', searchParams)
    
    if (!hasSearchCriteria) {
      const errorResponse = "I couldn't find any search criteria. Please specify:\n• A company name\n• A unit number\n• An invoice number\n• A VIN\n• A plate number\n• A date range (e.g., 'last week', 'this month')"
      
      await supabase
        .from('admin_conversations')
        .insert({
          user_id: userId,
          conversation_id: conversationId,
          message_role: 'assistant',
          message_content: errorResponse,
          message_metadata: { noCriteria: true }
        })
      
      return NextResponse.json({
        success: true,
        response: errorResponse,
        files: [],
        conversationId
      })
    }
    
    // Retrieve files based on parsed parameters
    console.log('Retrieving files with params:', searchParams)
    const retrieveResponse = await fetch(
      `${baseUrl}/api/admin/retrieve-files`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          searchParams: searchParams,
          userId: userId
        })
      }
    )
    
    const retrieveData = await retrieveResponse.json()
    console.log('Retrieve response:', { success: retrieveData.success, count: retrieveData.count })
    
    if (!retrieveData.success) {
      const errorResponse = "I encountered an error searching for files. Please try again."
      
      await supabase
        .from('admin_conversations')
        .insert({
          user_id: userId,
          conversation_id: conversationId,
          message_role: 'assistant',
          message_content: errorResponse,
          message_metadata: { retrieveError: true }
        })
      
      return NextResponse.json({
        success: true,
        response: errorResponse,
        files: [],
        conversationId
      })
    }
    
    const fileCount = retrieveData.count
    console.log('File count:', fileCount)
    
    // Check if we need confirmation
    if (fileCount >= CONFIRMATION_THRESHOLD) {
      console.log('File count exceeds threshold, asking for confirmation')
      const naturalSummary = (searchParams.naturalLanguageSummary as string) || 'your search'
      const confirmationText = `I found ${fileCount} files matching your search:\n\n${naturalSummary}\n\nThis would return ${fileCount} documents. Would you like me to show all of them?`
      
      await supabase
        .from('admin_conversations')
        .insert({
          user_id: userId,
          conversation_id: conversationId,
          message_role: 'assistant',
          message_content: confirmationText,
          message_metadata: {
            awaitingConfirmation: true,
            fileCount: fileCount,
            searchParams: searchParams
          }
        })
      
      return NextResponse.json({
        success: true,
        response: confirmationText,
        files: [],
        awaitingConfirmation: true,
        conversationId
      })
    }
    
    // File count is under threshold - return immediately
    console.log('File count under threshold, returning files')
    const naturalSummary = (searchParams.naturalLanguageSummary as string) || 'your search'
    const responseText = fileCount > 0
      ? `Found ${fileCount} file${fileCount > 1 ? 's' : ''}:\n\n${naturalSummary}`
      : `No files found matching your search:\n\n${naturalSummary}`
    
    await supabase
      .from('admin_conversations')
      .insert({
        user_id: userId,
        conversation_id: conversationId,
        message_role: 'assistant',
        message_content: responseText,
        message_metadata: {
          files: retrieveData.files,
          searchParams: searchParams
        }
      })
    
    return NextResponse.json({
      success: true,
      response: responseText,
      files: retrieveData.files,
      conversationId
    })
    
  } catch (error) {
    console.error('Admin chat error:', error)
    return NextResponse.json(
      { success: false, error: 'Chat processing failed' },
      { status: 500 }
    )
  }
}