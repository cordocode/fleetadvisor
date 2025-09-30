import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function POST(request: Request) {
  try {
    const { userId } = await request.json()
    
    console.log('Creating new conversation for user:', userId)
    
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
    
    // Generate new conversation ID
    const conversationId = randomUUID()
    
    // Insert welcome message
    const { error } = await supabase
      .from('admin_conversations')
      .insert({
        user_id: userId,
        conversation_id: conversationId,
        message_role: 'system',
        message_content: 'New conversation started',
        message_metadata: {
          conversationStart: true,
          timestamp: new Date().toISOString()
        }
      })
    
    if (error) {
      console.error('Error creating conversation:', error)
      return NextResponse.json(
        { success: false, error: 'Failed to create conversation' },
        { status: 500 }
      )
    }
    
    console.log('Created new conversation:', conversationId)
    
    return NextResponse.json({
      success: true,
      conversationId: conversationId
    })
    
  } catch (error) {
    console.error('New conversation error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to create conversation' },
      { status: 500 }
    )
  }
}

// GET endpoint to list user's conversations
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url)
    const userId = searchParams.get('userId')
    
    if (!userId) {
      return NextResponse.json(
        { success: false, error: 'Missing userId' },
        { status: 400 }
      )
    }
    
    // Get all unique conversation IDs for this user
    const { data, error } = await supabase
      .from('admin_conversations')
      .select('conversation_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    
    if (error) {
      return NextResponse.json(
        { success: false, error: 'Query failed' },
        { status: 500 }
      )
    }
    
    // Get unique conversations with their latest message time
    const conversationMap = new Map()
    data?.forEach(row => {
      if (!conversationMap.has(row.conversation_id)) {
        conversationMap.set(row.conversation_id, row.created_at)
      }
    })
    
    const conversations = Array.from(conversationMap.entries()).map(([id, timestamp]) => ({
      conversationId: id,
      lastActivity: timestamp
    }))
    
    return NextResponse.json({
      success: true,
      conversations: conversations
    })
    
  } catch (error) {
    console.error('List conversations error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to list conversations' },
      { status: 500 }
    )
  }
}