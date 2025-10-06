import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
)

export async function GET() {
  // Try uppercase DOT
  const { data: dotUpper, error: errorUpper } = await supabase.storage
    .from('DOT')
    .list('', { limit: 20 })
  
  // Try lowercase dot
  const { data: dotLower, error: errorLower } = await supabase.storage
    .from('dot')
    .list('', { limit: 20 })
  
  return NextResponse.json({
    uppercase_DOT: {
      error: errorUpper?.message || null,
      fileCount: dotUpper?.length || 0,
      files: dotUpper?.slice(0, 5).map(f => f.name) || []
    },
    lowercase_dot: {
      error: errorLower?.message || null,
      fileCount: dotLower?.length || 0,
      files: dotLower?.slice(0, 5).map(f => f.name) || []
    }
  })
}