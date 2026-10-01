export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      benchmark_history: {
        Row: {
          close_value: number
          created_at: string
          date: string
          id: string
          symbol: string
        }
        Insert: {
          close_value: number
          created_at?: string
          date: string
          id?: string
          symbol: string
        }
        Update: {
          close_value?: number
          created_at?: string
          date?: string
          id?: string
          symbol?: string
        }
        Relationships: []
      }
      daily_snapshots: {
        Row: {
          created_at: string
          fx_rate: number
          id: string
          profit_czk: number
          profit_pct: number
          profit_usd: number
          snapshot_date: string
          user_id: string | null
          value_czk: number
          value_usd: number
        }
        Insert: {
          created_at?: string
          fx_rate: number
          id?: string
          profit_czk?: number
          profit_pct?: number
          profit_usd?: number
          snapshot_date: string
          user_id?: string | null
          value_czk: number
          value_usd: number
        }
        Update: {
          created_at?: string
          fx_rate?: number
          id?: string
          profit_czk?: number
          profit_pct?: number
          profit_usd?: number
          snapshot_date?: string
          user_id?: string | null
          value_czk?: number
          value_usd?: number
        }
        Relationships: []
      }
      dividends: {
        Row: {
          amount_per_share: number
          created_at: string
          ex_date: string
          id: string
          pay_date: string | null
          shares_held: number | null
          status: string
          ticker: string
          total_amount_usd: number | null
          user_id: string | null
        }
        Insert: {
          amount_per_share: number
          created_at?: string
          ex_date: string
          id?: string
          pay_date?: string | null
          shares_held?: number | null
          status?: string
          ticker: string
          total_amount_usd?: number | null
          user_id?: string | null
        }
        Update: {
          amount_per_share?: number
          created_at?: string
          ex_date?: string
          id?: string
          pay_date?: string | null
          shares_held?: number | null
          status?: string
          ticker?: string
          total_amount_usd?: number | null
          user_id?: string | null
        }
        Relationships: []
      }
      earnings_calendar: {
        Row: {
          created_at: string
          earnings_date: string
          eps_actual: number | null
          eps_estimate: number | null
          id: string
          revenue_actual: number | null
          revenue_estimate: number | null
          ticker: string
          time_of_day: string | null
        }
        Insert: {
          created_at?: string
          earnings_date: string
          eps_actual?: number | null
          eps_estimate?: number | null
          id?: string
          revenue_actual?: number | null
          revenue_estimate?: number | null
          ticker: string
          time_of_day?: string | null
        }
        Update: {
          created_at?: string
          earnings_date?: string
          eps_actual?: number | null
          eps_estimate?: number | null
          id?: string
          revenue_actual?: number | null
          revenue_estimate?: number | null
          ticker?: string
          time_of_day?: string | null
        }
        Relationships: []
      }
      portfolio_goals: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          target_amount_usd: number
          target_date: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          target_amount_usd: number
          target_date?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          target_amount_usd?: number
          target_date?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      positions: {
        Row: {
          avg_cost_usd: number
          created_at: string
          holding_start_date: string | null
          id: string
          name: string
          sector: string | null
          shares: number
          ticker: string
          type: string
          updated_at: string
          user_id: string | null
        }
        Insert: {
          avg_cost_usd?: number
          created_at?: string
          holding_start_date?: string | null
          id?: string
          name: string
          sector?: string | null
          shares?: number
          ticker: string
          type?: string
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          avg_cost_usd?: number
          created_at?: string
          holding_start_date?: string | null
          id?: string
          name?: string
          sector?: string | null
          shares?: number
          ticker?: string
          type?: string
          updated_at?: string
          user_id?: string | null
        }
        Relationships: []
      }
      price_cache: {
        Row: {
          change_pct: number | null
          fetched_at: string
          prev_close: number | null
          price: number
          symbol: string
        }
        Insert: {
          change_pct?: number | null
          fetched_at?: string
          prev_close?: number | null
          price: number
          symbol: string
        }
        Update: {
          change_pct?: number | null
          fetched_at?: string
          prev_close?: number | null
          price?: number
          symbol?: string
        }
        Relationships: []
      }
      splits: {
        Row: {
          applied_at: string | null
          created_at: string
          detected_price: number | null
          id: string
          prev_close: number | null
          ratio: number
          source: string
          split_date: string
          status: string
          ticker: string
        }
        Insert: {
          applied_at?: string | null
          created_at?: string
          detected_price?: number | null
          id?: string
          prev_close?: number | null
          ratio: number
          source?: string
          split_date: string
          status?: string
          ticker: string
        }
        Update: {
          applied_at?: string | null
          created_at?: string
          detected_price?: number | null
          id?: string
          prev_close?: number | null
          ratio?: number
          source?: string
          split_date?: string
          status?: string
          ticker?: string
        }
        Relationships: []
      }
      // Hand-written: this file is generated, but it has not been regenerated since
      // 20260624240000_ticker_alias.sql / 20260624260000_alias_yahoo_symbol.sql or
      // 20260809100000_ticker_profiles.sql landed. Both entries are transcribed from those
      // migrations (NOT from the design docs — the plan's draft shows a single miss_count,
      // while the table carries one counter PER PROVIDER). Regenerating the file will
      // reproduce them; until then, deleting them breaks useTickerProfiles().
      ticker_alias: {
        Row: {
          alias: string
          canonical: string
          isin: string | null
          name: string | null
          source: string | null
          updated_at: string | null
          yahoo_symbol: string | null
        }
        Insert: {
          alias: string
          canonical: string
          isin?: string | null
          name?: string | null
          source?: string | null
          updated_at?: string | null
          yahoo_symbol?: string | null
        }
        Update: {
          alias?: string
          canonical?: string
          isin?: string | null
          name?: string | null
          source?: string | null
          updated_at?: string | null
          yahoo_symbol?: string | null
        }
        Relationships: []
      }
      ticker_profiles: {
        Row: {
          asset_type: string
          fetched_at: string
          finnhub_miss_count: number
          industry_raw: string | null
          name: string | null
          sector: string | null
          sector_raw: string | null
          source: string | null
          ticker: string
          yahoo_miss_count: number
        }
        Insert: {
          asset_type?: string
          fetched_at?: string
          finnhub_miss_count?: number
          industry_raw?: string | null
          name?: string | null
          sector?: string | null
          sector_raw?: string | null
          source?: string | null
          ticker: string
          yahoo_miss_count?: number
        }
        Update: {
          asset_type?: string
          fetched_at?: string
          finnhub_miss_count?: number
          industry_raw?: string | null
          name?: string | null
          sector?: string | null
          sector_raw?: string | null
          source?: string | null
          ticker?: string
          yahoo_miss_count?: number
        }
        Relationships: []
      }
      transactions: {
        Row: {
          cash_delta_applied: number
          created_at: string
          executed_at: string
          fee_usd: number
          id: string
          note: string | null
          price_usd: number
          shares: number
          side: string
          ticker: string
          user_id: string | null
        }
        Insert: {
          cash_delta_applied?: number
          created_at?: string
          executed_at: string
          fee_usd?: number
          id?: string
          note?: string | null
          price_usd: number
          shares: number
          side: string
          ticker: string
          user_id?: string | null
        }
        Update: {
          cash_delta_applied?: number
          created_at?: string
          executed_at?: string
          fee_usd?: number
          id?: string
          note?: string | null
          price_usd?: number
          shares?: number
          side?: string
          ticker?: string
          user_id?: string | null
        }
        Relationships: []
      }
      watchlist: {
        Row: {
          created_at: string
          id: string
          name: string
          note: string | null
          target_price_usd: number | null
          ticker: string
          user_id: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          note?: string | null
          target_price_usd?: number | null
          ticker: string
          user_id?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          note?: string | null
          target_price_usd?: number | null
          ticker?: string
          user_id?: string | null
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      apply_cash_delta: {
        Args: { p_delta: number; p_user_id: string }
        Returns: number
      }
      apply_split: { Args: { split_id: string }; Returns: undefined }
      claim_orphan_data: { Args: { p_email: string }; Returns: Json }
      dismiss_split: { Args: { split_id: string }; Returns: undefined }
      guess_sector_for_ticker: { Args: { t: string }; Returns: string }
      recalc_cash:
        | { Args: never; Returns: undefined }
        | { Args: { p_user_id: string }; Returns: undefined }
      recalc_position:
        | { Args: { p_ticker: string }; Returns: undefined }
        | { Args: { p_ticker: string; p_user_id: string }; Returns: undefined }
      transaction_cash_delta: {
        Args: {
          p_fee_usd: number
          p_price_usd: number
          p_shares: number
          p_side: string
          p_ticker: string
        }
        Returns: number
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const
