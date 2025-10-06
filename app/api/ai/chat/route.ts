// app/api/ai/chat/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import OpenAI from 'openai'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
})

// Tool definitions for OpenAI
const tools: OpenAI.Chat.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'resolve_company_name',
      description: 'Resolve user input to exact company names. ALWAYS call this first when user mentions a company.',
      parameters: {
        type: 'object',
        properties: {
          userInput: {
            type: 'string',
            description: 'What the user typed (e.g., "sturgeon", "enterprise")'
          }
        },
        required: ['userInput']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_dot_files',
      description: 'Search DOT inspection files in the DOT bucket',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Exact company name from resolve_company_name' },
          unit: { type: 'string', description: 'Unit number' },
          vin: { type: 'string', description: 'VIN' },
          plate: { type: 'string', description: 'License plate' },
          dateRange: { type: 'string', description: 'Date range like last_week, this_month' },
          limit: { type: 'number', description: 'Max results (default 15)' }
        },
        required: ['company']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_invoice_files',
      description: 'Search invoice files in the INVOICE bucket',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Exact company name from resolve_company_name' },
          unit: { type: 'string', description: 'Unit number' },
          invoice: { type: 'string', description: 'Invoice number' },
          dateRange: { type: 'string', description: 'Date range' },
          limit: { type: 'number', description: 'Max results (default 15)' }
        },
        required: ['company']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'lookup_company_code',
      description: 'Get the 6-digit access code for a company',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Exact company name from resolve_company_name' }
        },
        required: ['company']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_document_counts',
      description: 'Get count of documents without retrieving them',
      parameters: {
        type: 'object',
        properties: {
          docType: { type: 'string', enum: ['dot', 'invoice'], description: 'Document type' },
          company: { type: 'string', description: 'Company name' },
          dateRange: { type: 'string', description: 'Date range' }
        },
        required: ['docType', 'company']
      }
    }
  }
]

interface ConversationContext {
  isAdmin: boolean
  userCompany: string | null
  userId: string
  conversationId: string
  totalTokensUsed: number
}

interface ToolResult {
  tool: string
  args: Record<string, any>
  result: any
}

// Get system prompt based on user role
function getSystemPrompt(context: ConversationContext): string {
  const today = new Date().toLocaleDateString('en-US', { 
    weekday: 'long', 
    year: 'numeric', 
    month: 'long', 
    day: 'numeric' 
  })

  const basePrompt = `You are Fleet Advisor AI, an intelligent assistant for fleet document management.

TODAY'S DATE: ${today} (use this for all relative date calculations)
USER TYPE: ${context.isAdmin ? 'Admin (cross-company access)' : `Customer (${context.userCompany} only)`}

AVAILABLE CAPABILITIES:
1. Resolve company names to exact matches (resolve_company_name)
2. Search DOT inspection files from the DOT bucket
3. Search invoice files from the INVOICE bucket  
4. Look up company access codes
5. Get document counts for validation

FILE STRUCTURE:
- DOT bucket: company__dot__I-invoice__U-unit__V-vin__D-date__P-plate.pdf
- INVOICE bucket: company__I-invoice__U-unit__V-vin__D-date__P-plate.pdf (no __dot__ marker)

IMPORTANT WORKFLOW:
- When a user mentions a company name, first resolve it to the exact name
- Then use the resolved name for any searches or lookups
- When searching for "last" or "most recent" files, use limit: 1
- Always complete the full task - don't stop after resolving a company
- If user just says "files" or "documents", ask which type (DOT or INVOICE)

RESPONSE GUIDELINES:
- Be conversational and helpful
- Describe results clearly
- If no files are found, say so clearly
- If multiple companies match, ask for clarification`

  if (!context.isAdmin && context.userCompany) {
    return basePrompt + `\n\nUSER'S COMPANY: ${context.userCompany}
You can only search within this company's files.`
  }

  return basePrompt + `\n\nADMIN MODE: You have access to all companies' files.`
}

// Execute tool calls
async function executeTool(name: string, args: Record<string, any>, context: ConversationContext) {
  console.log(`Executing tool: ${name}`, args)
  
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
  
  try {
    const response = await fetch(`${baseUrl}/api/ai/tools/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        ...args, 
        context: {
          isAdmin: context.isAdmin,
          userCompany: context.userCompany,
          userId: context.userId
        }
      })
    })
    
    const data = await response.json()
    return data
  } catch (error) {
    console.error(`Tool execution error for ${name}:`, error)
    return { error: `Failed to execute ${name}` }
  }
}

export async function POST(request: Request) {
  try {
    const { message, conversationId, userId } = await request.json()
    
    console.log('=== AI CHAT REQUEST ===')
    console.log('Message:', message)
    console.log('ConversationId:', conversationId)
    console.log('UserId:', userId)
    
    // Get user profile and company
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin, company_id')
      .eq('user_id', userId)
      .single()
    
    if (!profile) {
      return NextResponse.json(
        { success: false, error: 'User profile not found' },
        { status: 403 }
      )
    }
    
    let userCompany = null
    if (profile.company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('name')
        .eq('id', profile.company_id)
        .single()
      
      userCompany = company?.name || null
    }
    
    const context: ConversationContext = {
      isAdmin: profile.is_admin || false,
      userCompany,
      userId,
      conversationId,
      totalTokensUsed: 0
    }
    
    console.log('User context:', { 
      isAdmin: context.isAdmin, 
      company: context.userCompany 
    })
    
    // Store user message
    await supabase
      .from('admin_conversations')
      .insert({
        user_id: userId,
        conversation_id: conversationId,
        message_role: 'user',
        message_content: message,
        message_metadata: {}
      })
    
    // Load recent conversation history (last 20 messages for context)
    const { data: history } = await supabase
      .from('admin_conversations')
      .select('message_role, message_content, message_metadata')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(20)
    
    const conversationHistory = (history || [])
      .reverse()
      .map(msg => ({
        role: msg.message_role === 'user' ? 'user' as const : 'assistant' as const,
        content: msg.message_content
      }))
    
    // Build initial messages for OpenAI
    let messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: getSystemPrompt(context) },
      ...conversationHistory
    ]
    
    // Keep track of all tool results for final extraction
    const allToolResults: ToolResult[] = []
    let finalResponse = ''
    let maxIterations = 5 // Prevent infinite loops
    let iteration = 0
    
    // Main loop to handle tool calls
    while (iteration < maxIterations) {
      iteration++
      
      // Call OpenAI
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages,
        tools,
        tool_choice: 'auto',
        temperature: 0.3
      })
      
      const responseMessage = completion.choices[0].message
      
      // If no tool calls, we have our final response
      if (!responseMessage.tool_calls || responseMessage.tool_calls.length === 0) {
        finalResponse = responseMessage.content || ''
        if (iteration === 1) {
          // First iteration with no tools means tracking token usage
          context.totalTokensUsed += completion.usage?.total_tokens || 0
        }
        break
      }
      
      // Execute tool calls
      const toolMessages: OpenAI.Chat.ChatCompletionToolMessageParam[] = []
      
      for (const toolCall of responseMessage.tool_calls) {
        // Handle the union type properly
        const functionCall = toolCall as OpenAI.Chat.ChatCompletionMessageToolCall & {
          function: { name: string; arguments: string }
        }
        
        if (!functionCall.function) {
          console.error('Invalid tool call structure:', toolCall)
          continue
        }
        
        const functionName = functionCall.function.name
        let functionArgs: Record<string, any> = {}
        
        try {
          functionArgs = JSON.parse(functionCall.function.arguments)
        } catch (e) {
          console.error('Error parsing function arguments:', e)
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ error: 'Failed to parse arguments' })
          })
          continue
        }
        
        // Execute the tool
        const result = await executeTool(functionName, functionArgs, context)
        
        // Store for later
        allToolResults.push({
          tool: functionName,
          args: functionArgs,
          result
        })
        
        // Add tool response message
        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        })
      }
      
      // Add assistant message with tool calls and tool responses to messages
      messages.push({
        role: 'assistant',
        content: responseMessage.content || null,
        tool_calls: responseMessage.tool_calls.map(tc => ({
          id: tc.id,
          type: 'function' as const,
          function: (tc as any).function
        }))
      })
      messages.push(...toolMessages)
      
      // Update token usage
      context.totalTokensUsed += completion.usage?.total_tokens || 0
    }
    
    // Extract files from all tool results
    const files = allToolResults
      .filter(tr => tr.result.files)
      .flatMap(tr => tr.result.files)
    
    // Store assistant response
    await supabase
      .from('admin_conversations')
      .insert({
        user_id: userId,
        conversation_id: conversationId,
        message_role: 'assistant',
        message_content: finalResponse,
        message_metadata: {
          toolCalls: allToolResults.map(tr => ({
            tool: tr.tool,
            args: tr.args
          })),
          files,
          tokensUsed: context.totalTokensUsed
        }
      })
    
    return NextResponse.json({
      success: true,
      response: finalResponse,
      files,
      conversationId
    })
    
  } catch (error) {
    console.error('AI chat error:', error)
    return NextResponse.json(
      { success: false, error: 'Chat processing failed' },
      { status: 500 }
    )
  }
}