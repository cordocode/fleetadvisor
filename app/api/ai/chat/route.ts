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
  lastResolvedCompany: {
    userInput: string
    resolvedName: string
    messageIndex: number
  } | null
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

CRITICAL RULES:
- ALWAYS call resolve_company_name before any search involving companies
- Never return more than 15 documents per search
- If user just says "files" or "documents", ask which bucket (DOT or INVOICE)
- Track token usage (limit: 100,000 tokens)
- For ambiguous references like "their" or "that company", use conversation context`

  if (!context.isAdmin && context.userCompany) {
    return basePrompt + `\n\nUSER'S COMPANY: ${context.userCompany}
You can only search within this company's files.`
  }

  return basePrompt + `\n\nADMIN MODE: You have access to all companies' files.
When searching, always clarify which company if not specified.`
}

// Execute tool calls
async function executeTool(name: string, args: any, context: ConversationContext) {
  console.log(`Executing tool: ${name}`, args)
  
  // Get base URL from environment or use default
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
      totalTokensUsed: 0,
      lastResolvedCompany: null
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
    
    // Build messages for OpenAI
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: getSystemPrompt(context) },
      ...conversationHistory
    ]
    
    // Call OpenAI with tools
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages,
      tools,
      tool_choice: 'auto',
      temperature: 0.3
    })
    
    const responseMessage = completion.choices[0].message
    const toolCalls = responseMessage.tool_calls || []
    
    // Execute any tool calls
    const toolResults = []
    for (const toolCall of toolCalls) {
      // Handle the tool call - check if it has the expected structure
      let functionName: string
      let functionArgs: any
      
      // Handle different possible structures
      if ('function' in toolCall && typeof toolCall.function === 'object') {
        functionName = (toolCall.function as any).name
        functionArgs = JSON.parse((toolCall.function as any).arguments)
      } else {
        // Fallback - try to access properties directly
        functionName = (toolCall as any).function?.name || ''
        const argsString = (toolCall as any).function?.arguments || '{}'
        functionArgs = JSON.parse(argsString)
      }
      
      if (!functionName) {
        console.error('Invalid tool call structure:', toolCall)
        continue
      }
      
      const result = await executeTool(functionName, functionArgs, context)
      
      toolResults.push({
        tool: functionName,
        args: functionArgs,
        result
      })
      
      // Update context if company was resolved
      if (functionName === 'resolve_company_name' && result.matchType === 'single') {
        context.lastResolvedCompany = {
          userInput: functionArgs.userInput,
          resolvedName: result.matches[0].name,
          messageIndex: messages.length
        }
      }
    }
    
    // Generate final response
    let finalResponse = responseMessage.content || ''
    
    // If tools were called, append results to context and get final response
    if (toolResults.length > 0) {
      const toolResultsMessage = toolResults.map(tr => 
        `Tool ${tr.tool} returned: ${JSON.stringify(tr.result)}`
      ).join('\n')
      
      const followUpMessages: OpenAI.Chat.ChatCompletionMessageParam[] = [
        ...messages,
        { 
          role: 'assistant', 
          content: responseMessage.content || ''
        },
        { 
          role: 'system',
          content: `Tool results:\n${toolResultsMessage}\n\nNow provide a helpful response to the user based on these results.`
        }
      ]
      
      const followUpCompletion = await openai.chat.completions.create({
        model: 'gpt-4o',
        messages: followUpMessages,
        temperature: 0.3
      })
      
      finalResponse = followUpCompletion.choices[0].message.content || ''
    }
    
    // Extract any files from tool results
    const files = toolResults
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
          toolCalls: toolResults,
          files,
          tokensUsed: completion.usage?.total_tokens || 0,
          lastResolvedCompany: context.lastResolvedCompany
        }
      })
    
    return NextResponse.json({
      success: true,
      response: finalResponse,
      files,
      conversationId,
      toolsUsed: toolResults.map(tr => tr.tool)
    })
    
  } catch (error) {
    console.error('AI chat error:', error)
    return NextResponse.json(
      { success: false, error: 'Chat processing failed' },
      { status: 500 }
    )
  }
}