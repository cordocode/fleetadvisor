import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: Request) {
  try {
    const { conversationId, userId } = await request.json()
    
    console.log('Loading conversation:', { conversationId, userId })
    
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
    
    // Load conversation messages
    const { data: messages, error } = await supabase
      .from('admin_conversations')
      .select('*')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .order('created_at', { ascending: true })
    
    if (error) {
      console.error('Error loading conversation:', error)
      return NextResponse.json(
        { success: false, error: 'Failed to load conversation' },
        { status: 500 }
      )
    }
    
    // Transform to chat message format
    const chatHistory = messages.map(msg => ({
      role: msg.message_role,
      content: msg.message_content,
      files: msg.message_metadata?.files || [],
      metadata: msg.message_metadata
    }))
    
    console.log(`Loaded ${chatHistory.length} messages from conversation`)
    
    return NextResponse.json({
      success: true,
      messages: chatHistory,
      count: chatHistory.length
    })
    
  } catch (error) {
    console.error('Load conversation error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to load conversation' },
      { status: 500 }
    )
  }
}

// GET endpoint to check if conversation exists
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const conversationId = searchParams.get('conversationId')
    const userId = searchParams.get('userId')
    
    if (!conversationId || !userId) {
      return NextResponse.json(
        { success: false, error: 'Missing parameters' },
        { status: 400 }
      )
    }
    
    const { data, error } = await supabase
      .from('admin_conversations')
      .select('id')
      .eq('conversation_id', conversationId)
      .eq('user_id', userId)
      .limit(1)
    
    if (error) {
      return NextResponse.json(
        { success: false, error: 'Query failed' },
        { status: 500 }
      )
    }
    
    return NextResponse.json({
      success: true,
      exists: (data?.length || 0) > 0
    })
    
  } catch (error) {
    console.error('Check conversation error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to check conversation' },
      { status: 500 }
    )
  }
}