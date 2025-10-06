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

// -------------------- ORIGIN RESOLUTION (fixes localhost in prod) --------------------
function normalizeSiteUrl(raw?: string | null): string | null {
  if (!raw) return null
  let s = raw.trim()
  if (!s) return null
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`
  return s.replace(/\/$/, '')
}

function getOrigin(): string {
  // 1) You set this in Vercel (e.g., https://fleetadvisor.ai)
  const explicit = normalizeSiteUrl(process.env.NEXT_PUBLIC_SITE_URL)
  if (explicit) return explicit

  // 2) Vercel-provided host for previews/prod
  const vercelHost = process.env.VERCEL_URL || process.env.NEXT_PUBLIC_VERCEL_URL
  const vercelUrl = normalizeSiteUrl(vercelHost)
  if (vercelUrl) return vercelUrl

  // 3) Local dev
  return 'http://localhost:3000'
}
// ------------------------------------------------------------------------------------

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
      description: 'Search DOT inspection files in the DOT bucket. Files are always sorted newest first.',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Exact company name from resolve_company_name' },
          unit: { type: 'string', description: 'Unit number' },
          vin: { type: 'string', description: 'VIN' },
          plate: { type: 'string', description: 'License plate' },
          dateRange: { type: 'string', description: 'OPTIONAL date range - only use when user specifies a time period. DO NOT use for "latest" or "most recent" requests.' },
          limit: { type: 'number', description: 'Max results (default 15). Use this for "latest X" requests.' }
        },
        required: ['company']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_invoice_files',
      description: 'Search invoice files in the INVOICE bucket. Files are always sorted newest first.',
      parameters: {
        type: 'object',
        properties: {
          company: { type: 'string', description: 'Exact company name from resolve_company_name' },
          unit: { type: 'string', description: 'Unit number' },
          invoice: { type: 'string', description: 'Invoice number' },
          dateRange: { type: 'string', description: 'OPTIONAL date range - only use when user specifies a time period. DO NOT use for "latest" or "most recent" requests.' },
          limit: { type: 'number', description: 'Max results (default 15). Use this for "latest X" requests.' }
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
          dateRange: { type: 'string', description: 'OPTIONAL date range - only use when user specifies a time period' }
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
  resolvedCompanies: Record<string, string> // Track resolved company names
}

interface ToolResult {
  tool: string
  args: Record<string, unknown>
  result: unknown
}

// Type for tool calls to handle OpenAI's union type
interface FunctionToolCall {
  id: string
  function?: {
    name: string
    arguments: string
  }
}

// Result shapes we care about
type Match = { name?: string; displayName?: string; confidence?: number }
type HasMatches = { matches?: Match[] }
type HasFiles = { files?: unknown[] }

function hasMatches(x: unknown): x is HasMatches {
  if (typeof x !== 'object' || x === null) return false
  if (!('matches' in x)) return false
  const val = (x as { matches: unknown }).matches
  return Array.isArray(val)
}

function hasFiles(x: unknown): x is HasFiles {
  if (typeof x !== 'object' || x === null) return false
  if (!('files' in x)) return false
  const val = (x as { files: unknown }).files
  return Array.isArray(val)
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

DATABASE LIMITATIONS (only mention if user insists and it's the actual problem):
- Invoice files: System only has invoices from September 18th, 2025 onward
- DOT files: All historical DOT inspections are in the system, but date metadata only available from September 18th, 2025
- IMPORTANT: Only mention these limitations if:
  1. User pushes back twice (e.g., "there should definitely be...", "I know it exists...")
  2. AND the search is specifically failing due to these limitations (searching for dates before Sept 18)
  3. NOT as a generic excuse when files aren't found
- When relevant, suggest alternative search methods for DOT files (unit, VIN, plate)
- Example when to mention: User insists "Find my August 2025 invoice" → after not finding, explain the Sept 18 limitation
- Example when NOT to mention: General search fails → try different parameters first, don't blame limitations

FILE SEARCH RESPONSE FORMAT:
When files are found through search tools:
- Provide a brief summary of what was found
- Mention key details like count, date range, or invoice numbers if relevant
- DO NOT include URLs, links, or markdown formatting with [text](url) syntax
- DO NOT list each file with its URL
- The UI automatically displays all files as interactive cards below your message
- Keep your response conversational and focused on the summary

Good response examples:
- "I found 5 recent invoices for Sturgeon Electric, all from September 29, 2025."
- "Here are the 3 DOT inspections for unit 123 from last week."
- "I found invoice 46589 for unit 14010311 from September 29."
- "Found 5 invoices: 46589-46593, all dated September 29, 2025."

Bad response examples (avoid these):
- Including any URLs or links in the response
- Using markdown format like "[Invoice 46589](https://...)"
- Listing each file with its full URL path

FILE SEARCH RESPONSE FORMAT:
When files are found through search tools:
- Provide a brief summary of what was found
- Mention key details like count, date range, or invoice numbers if relevant
- DO NOT include URLs, links, or markdown formatting
- DO NOT list each file with its URL
- The UI automatically displays all files as interactive cards below your message

Good response examples:
- "I found 5 recent invoices for Sturgeon Electric, all from September 29, 2025."
- "Here are the 3 DOT inspections for unit 123 from last week."
- "I found invoice 46589 for unit 14010311."

Bad response examples (avoid these):
- Including any URLs or links in the response
- Using markdown link format like [Invoice 123](url...)
- Listing each file with its full details and URL

CRITICAL COMPANY NAME HANDLING:
- When resolve_company_name returns a single match: ALWAYS use the 'name' field (kebab-case format like "herc-rentals")
- When resolve_company_name returns multiple matches:
  1. Present the options to the user using their displayName for readability
  2. Ask them to select by number (1, 2, etc.)
  3. When they respond, use the corresponding company's 'name' field (NOT displayName)
- NEVER use displayName in tool calls - only use the exact 'name' field
- Company names in files are ALWAYS in kebab-case format (e.g., "herc-rentals", "sturgeon-electric")
- Remember resolved company names for the conversation to avoid re-asking

IMPORTANT WORKFLOW:
- When a user mentions a company name, first resolve it to the exact name
- If you get multiple matches and HIGH confidence (>= 0.8) for ALL of them, still ask for clarification
- Use the resolved 'name' field (not displayName) for all subsequent tool calls
- CRITICAL FOR "LATEST/RECENT" REQUESTS:
  * When user asks for "latest", "most recent", "last X" files - DO NOT add a dateRange parameter
  * The search tools automatically sort by date (newest first)
  * Just set the limit parameter to the number requested (e.g., "last 5" → limit: 5)
  * Let the sorting handle finding the most recent files across ALL dates
  * Only use dateRange when user specifically mentions a time period (e.g., "from September", "last week")
- Always complete the full task - don't stop after resolving a company
- If user just says "files" or "documents", ask which type (DOT or INVOICE)

RESPONSE GUIDELINES:
- Be conversational and helpful
- When presenting multiple company matches, format them clearly with numbers
- Describe results clearly
- Always use the exact resolved company name in searches

HANDLING FAILED SEARCHES:
- First attempt: If no results, suggest adjusting search parameters (different date range, check spelling, etc.)
- If user insists (pushes back): Try alternative search approaches first
- Only mention database limitations if:
  * User has pushed back twice that something should exist
  * AND their search criteria directly conflicts with known limitations
  * Example: Searching for invoice from July 2025 → mention Sept 18 cutoff
  * Example: Searching for DOT by date before Sept 18 → suggest searching by unit/VIN/plate
- Never use limitations as default excuse - most search failures are due to other factors
- When limitations are relevant, explain briefly: "Just so you know, when I was created, invoice records only go back to September 18th, 2025" or "DOT files exist historically but dates are only available from September 18th onward - try searching by unit number instead"

CRITICAL: When files are found, DO NOT include URLs or markdown links in your response
  * The UI automatically displays files as clickable cards below your message
  * Just describe what was found (e.g., "I found 5 invoices from September 2025")
  * You can mention invoice numbers, units, dates but NO URLs
  * Example good response: "I found 5 recent invoices for Sturgeon Electric from September 29, 2025"
  * Example bad response: "Here are the files: [Invoice 46589](url...)" 

EXAMPLES OF PROPER HANDLING:
- "Find the 5 latest invoices for Sturgeon" → search_invoice_files with company:"sturgeon-electric", limit:5 (NO dateRange)
- "Show me last week's DOT files" → search_dot_files with dateRange:"last_week"
- "Get the most recent invoice" → search_invoice_files with limit:1 (NO dateRange)
- "Find September invoices" → search_invoice_files with dateRange:"September 2024" or appropriate date range`

  if (!context.isAdmin && context.userCompany) {
    return basePrompt + `\n\nUSER'S COMPANY: ${context.userCompany}
You can only search within this company's files.`
  }

  return basePrompt + `\n\nADMIN MODE: You have access to all companies' files.

RESOLVED COMPANIES THIS CONVERSATION:
${Object.entries(context.resolvedCompanies).map(([display, actual]) => 
  `- "${display}" → "${actual}"`).join('\n') || 'None yet'}`
}

// Execute tool calls
async function executeTool(name: string, args: Record<string, unknown>, context: ConversationContext) {
  console.log(`Executing tool: ${name}`, args)

  // Build a correct origin for dev/prod (uses NEXT_PUBLIC_SITE_URL you set)
  const origin = getOrigin()
  const url = `${origin}/api/ai/tools/${name}`
  console.log('[chat.executeTool] origin:', origin, 'url:', url)

  try {
    const response = await fetch(url, {
      method: 'POST',
      cache: 'no-store',
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
    
    const data: unknown = await response.json()
    return data
  } catch (error) {
    console.error(`Tool execution error for ${name}:`, error)
    return { error: `Failed to execute ${name}` }
  }
}

export async function POST(request: Request) {
  try {
    const parsed = (await request.json()) as {
      message: string
      conversationId: string
      userId: string
    }

    const message = (parsed?.message ?? '').trim()
    const conversationId = parsed?.conversationId ?? ''
    const userId = parsed?.userId ?? ''
    
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
    
    let userCompany: string | null = null
    if (profile.company_id) {
      const { data: company } = await supabase
        .from('companies')
        .select('name')
        .eq('id', profile.company_id)
        .single()
      
      userCompany = (company?.name as string | undefined) ?? null
    }
    
    const context: ConversationContext = {
      isAdmin: Boolean(profile.is_admin),
      userCompany,
      userId,
      conversationId,
      totalTokensUsed: 0,
      resolvedCompanies: {} // Track resolved companies
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
    
    const conversationHistory = (history ?? [])
      .reverse()
      .map(msg => ({
        role: msg.message_role === 'user' ? 'user' as const : 'assistant' as const,
        content: msg.message_content
      }))
    
    // Extract previously resolved companies from history
    history?.forEach(msg => {
      const meta = msg.message_metadata as unknown
      if (
        typeof meta === 'object' &&
        meta !== null &&
        'resolvedCompanies' in meta &&
        typeof (meta as { resolvedCompanies?: unknown }).resolvedCompanies === 'object' &&
        (meta as { resolvedCompanies?: unknown }).resolvedCompanies !== null
      ) {
        Object.assign(
          context.resolvedCompanies,
          (meta as { resolvedCompanies: Record<string, string> }).resolvedCompanies
        )
      }
    })
    
    // Build initial messages for OpenAI - mutable array
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: 'system', content: getSystemPrompt(context) },
      ...conversationHistory
    ]
    
    // Keep track of all tool results for final extraction
    const allToolResults: ToolResult[] = []
    let finalResponse = ''
    const maxIterations = 5 // Prevent infinite loops
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
        // Cast to our thin interface to avoid union headaches
        const functionCall = toolCall as FunctionToolCall
        
        if (!functionCall.function) {
          console.error('Invalid tool call structure:', toolCall)
          continue
        }
        
        const functionName = functionCall.function.name
        let functionArgs: Record<string, unknown> = {}
        
        try {
          functionArgs = JSON.parse(functionCall.function.arguments) as Record<string, unknown>
        } catch {
          toolMessages.push({
            role: 'tool',
            tool_call_id: functionCall.id,
            content: JSON.stringify({ error: 'Failed to parse arguments' })
          })
          continue
        }
        
        // Execute the tool (uses correct origin)
        const result: unknown = await executeTool(functionName, functionArgs, context)
        
        // Track resolved company names (no 'any' via type guard)
        if (functionName === 'resolve_company_name' && hasMatches(result)) {
          for (const match of result.matches ?? []) {
            if (match && typeof match === 'object' && 'name' in match && 'displayName' in match) {
              const m = match as { name?: string; displayName?: string }
              if (m.name && m.displayName) {
                context.resolvedCompanies[m.displayName] = m.name
              }
            }
          }
        }
        
        // Store for later
        allToolResults.push({
          tool: functionName,
          args: functionArgs,
          result
        })
        
        // Add tool response message
        toolMessages.push({
          role: 'tool',
          tool_call_id: functionCall.id,
          content: JSON.stringify(result)
        })
      }
      
      // Add assistant message with tool calls and tool responses to messages
      messages.push({
        role: 'assistant',
        content: responseMessage.content || null,
        tool_calls: responseMessage.tool_calls.map(tc => {
          const fcall = tc as FunctionToolCall
          return {
            id: fcall.id,
            type: 'function' as const,
            function: {
              name: fcall.function?.name || '',
              arguments: fcall.function?.arguments || '{}'
            }
          }
        })
      })
      messages.push(...toolMessages)
      
      // Update token usage
      context.totalTokensUsed += completion.usage?.total_tokens || 0
    }
    
    // Extract files from all tool results without 'any'
    const files: unknown[] = allToolResults
      .filter(tr => hasFiles(tr.result))
      .flatMap(tr => (tr.result as HasFiles).files ?? [])
    
    // Store assistant response with resolved companies
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
          tokensUsed: context.totalTokensUsed,
          resolvedCompanies: context.resolvedCompanies
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
