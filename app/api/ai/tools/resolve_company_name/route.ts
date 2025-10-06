// app/api/ai/tools/resolve_company_name/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

interface CompanyMatch {
  name: string
  displayName: string
  confidence: number
}

// Calculate Levenshtein distance for fuzzy matching
function levenshteinDistance(str1: string, str2: string): number {
  const matrix = []
  
  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i]
  }
  
  for (let j = 0; j <= str1.length; j++) {
    matrix[0][j] = j
  }
  
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1]
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        )
      }
    }
  }
  
  return matrix[str2.length][str1.length]
}

// Normalize string for matching
function normalize(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, '')
}

// Calculate match confidence score
function calculateMatchScore(input: string, companyName: string): number {
  const normalizedInput = normalize(input)
  const normalizedCompany = normalize(companyName)
  
  // Exact match
  if (normalizedCompany === normalizedInput) {
    return 1.0
  }
  
  // Company starts with input
  if (normalizedCompany.startsWith(normalizedInput)) {
    return 0.9
  }
  
  // Company contains input
  if (normalizedCompany.includes(normalizedInput)) {
    return 0.7
  }
  
  // Input contains company (for cases like "sturgeon electric" matching "sturgeon")
  if (normalizedInput.includes(normalizedCompany)) {
    return 0.75
  }
  
  // Fuzzy match using Levenshtein distance
  const distance = levenshteinDistance(normalizedInput, normalizedCompany)
  const maxLength = Math.max(normalizedInput.length, normalizedCompany.length)
  const similarity = 1 - (distance / maxLength)
  
  return Math.max(0, similarity)
}

// Convert kebab-case to display name
function toDisplayName(companyName: string): string {
  // Special cases
  if (companyName === 'fleet-advisor-ai-admin') {
    return 'Fleet Advisor Admin'
  }
  
  return companyName
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ')
}

export async function POST(request: Request) {
  try {
    const { userInput, context } = await request.json()
    
    console.log('=== RESOLVE COMPANY NAME ===')
    console.log('User input:', userInput)
    console.log('Is admin:', context?.isAdmin)
    console.log('User company:', context?.userCompany)
    
    // If not admin and has a user company, check if they're trying to search their own company
    if (!context?.isAdmin && context?.userCompany) {
      const userCompanyScore = calculateMatchScore(userInput, context.userCompany)
      
      // If they're clearly referring to their own company, return it immediately
      if (userCompanyScore > 0.7) {
        console.log('Matched to user\'s own company')
        return NextResponse.json({
          matchType: 'single',
          matches: [{
            name: context.userCompany,
            displayName: toDisplayName(context.userCompany),
            confidence: userCompanyScore
          }]
        })
      }
      
      // For non-admin users, they can only access their own company
      console.log('Non-admin user cannot access other companies')
      return NextResponse.json({
        matchType: 'restricted',
        matches: [],
        message: `You can only access files for ${toDisplayName(context.userCompany)}`
      })
    }
    
    // For admin users or when checking all companies
    const { data: companies, error } = await supabase
      .from('companies')
      .select('name')
      .order('name')
    
    if (error) {
      console.error('Error fetching companies:', error)
      return NextResponse.json(
        { success: false, error: 'Failed to fetch companies' },
        { status: 500 }
      )
    }
    
    if (!companies || companies.length === 0) {
      return NextResponse.json({
        matchType: 'none',
        matches: []
      })
    }
    
    // Score each company
    const scored = companies.map(company => ({
      name: company.name,
      displayName: toDisplayName(company.name),
      confidence: calculateMatchScore(userInput, company.name)
    }))
    
    // Sort by confidence
    scored.sort((a, b) => b.confidence - a.confidence)
    
    // Apply confidence thresholds
    const SINGLE_MATCH_THRESHOLD = 0.8
    const MULTIPLE_MATCH_THRESHOLD = 0.6
    
    // Check for single high-confidence match
    const highConfidenceMatches = scored.filter(s => s.confidence >= SINGLE_MATCH_THRESHOLD)
    const mediumConfidenceMatches = scored.filter(s => s.confidence >= MULTIPLE_MATCH_THRESHOLD)
    
    console.log('Scoring results:', {
      totalCompanies: companies.length,
      highConfidence: highConfidenceMatches.length,
      mediumConfidence: mediumConfidenceMatches.length,
      topMatch: scored[0]
    })
    
    // Decision logic
    if (highConfidenceMatches.length === 1) {
      // Single high-confidence match - proceed automatically
      console.log('Single high-confidence match found')
      return NextResponse.json({
        matchType: 'single',
        matches: [highConfidenceMatches[0]]
      })
    }
    
    if (mediumConfidenceMatches.length > 0) {
      // Multiple possible matches - need clarification
      console.log(`Found ${mediumConfidenceMatches.length} possible matches`)
      return NextResponse.json({
        matchType: 'multiple',
        matches: mediumConfidenceMatches.slice(0, 10) // Limit to top 10
      })
    }
    
    // No good matches found
    console.log('No matches found above threshold')
    
    // Suggest top 3 companies as alternatives
    const suggestions = scored.slice(0, 3).filter(s => s.confidence > 0.3)
    
    return NextResponse.json({
      matchType: 'none',
      matches: [],
      suggestions: suggestions.length > 0 ? suggestions : undefined
    })
    
  } catch (error) {
    console.error('Company resolution error:', error)
    return NextResponse.json(
      { success: false, error: 'Failed to resolve company name' },
      { status: 500 }
    )
  }
}