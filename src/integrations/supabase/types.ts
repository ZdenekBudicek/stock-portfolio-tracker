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
      // B?h 6: synchronized from the reviewed test-target migration DDL; live generation pending.
      chat_threads: {
        Row: {
          id: string
          user_id: string
          title: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          user_id: string
          title: string
          created_at?: string
          updated_at?: string
        }
        Update: {
          id?: string
          user_id?: string
          title?: string
          created_at?: string
          updated_at?: string
        }
        Relationships: []
      }
      chat_messages: {
        Row: {
          id: string
          thread_id: string
          user_id: string
          request_id: string
          seq: number
          role: string
          content: string
          lang: string
          trace: Json
          links: Json
          created_at: string
        }
        Insert: {
          id?: string
          thread_id: string
          user_id: string
          request_id: string
          seq: number
          role: string
          content: string
          lang: string
          trace?: Json
          links?: Json
          created_at?: string
        }
        Update: {
          id?: string
          thread_id?: string
          user_id?: string
          request_id?: string
          seq?: number
          role?: string
          content?: string
          lang?: string
          trace?: Json
          links?: Json
          created_at?: string
        }
        Relationships: [{
          foreignKeyName: "chat_messages_thread_id_user_id_fkey"
          columns: ["thread_id", "user_id"]
          isOneToOne: false
          referencedRelation: "chat_threads"
          referencedColumns: ["id", "user_id"]
        }]
      }
      agent_runs: {
        Row: {
          id: string
          thread_id: string
          user_id: string
          request_id: string
          model: string | null
          router_model: string | null
          tokens_in: number
          tokens_out: number
          max_call_tokens: number
          tool_calls: number
          tools_used: string[]
          wall_ms: number
          ttft_ms: number | null
          outcome: string
          grounding_ok: boolean
          calculation_version: string
          error_code: string | null
          created_at: string
        }
        Insert: {
          id?: string
          thread_id: string
          user_id: string
          request_id: string
          model?: string | null
          router_model?: string | null
          tokens_in: number
          tokens_out: number
          max_call_tokens: number
          tool_calls: number
          tools_used: string[]
          wall_ms: number
          ttft_ms?: number | null
          outcome: string
          grounding_ok: boolean
          calculation_version: string
          error_code?: string | null
          created_at?: string
        }
        Update: {
          id?: string
          thread_id?: string
          user_id?: string
          request_id?: string
          model?: string | null
          router_model?: string | null
          tokens_in?: number
          tokens_out?: number
          max_call_tokens?: number
          tool_calls?: number
          tools_used?: string[]
          wall_ms?: number
          ttft_ms?: number | null
          outcome?: string
          grounding_ok?: boolean
          calculation_version?: string
          error_code?: string | null
          created_at?: string
        }
        Relationships: [{
          foreignKeyName: "agent_runs_thread_id_user_id_fkey"
          columns: ["thread_id", "user_id"]
          isOneToOne: false
          referencedRelation: "chat_threads"
          referencedColumns: ["id", "user_id"]
        }]
      }
      agent_daily_usage: {
        Row: {
          user_id: string
          day: string
          used: number
        }
        Insert: {
          user_id: string
          day: string
          used: number
        }
        Update: {
          user_id?: string
          day?: string
          used?: number
        }
        Relationships: []
      }
      agent_requests: {
        Row: {
          user_id: string
          request_id: string
          thread_id: string
          requested_thread_id: string | null
          fingerprint: string
          question_hash: string
          lang: string
          state: string
          execution_token_hash: string
          created_at: string
          completed_at: string | null
          answer: Json | null
        }
        Insert: {
          user_id: string
          request_id: string
          thread_id: string
          requested_thread_id?: string | null
          fingerprint: string
          question_hash: string
          lang: string
          state: string
          execution_token_hash: string
          created_at?: string
          completed_at?: string | null
          answer?: Json | null
        }
        Update: {
          user_id?: string
          request_id?: string
          thread_id?: string
          requested_thread_id?: string | null
          fingerprint?: string
          question_hash?: string
          lang?: string
          state?: string
          execution_token_hash?: string
          created_at?: string
          completed_at?: string | null
          answer?: Json | null
        }
        Relationships: []
      }
      stock_news: {
        Row: {
          symbol: string
          items: Json | null
          fetched_at: string | null
        }
        Insert: {
          symbol: string
          items?: Json | null
          fetched_at?: string | null
        }
        Update: {
          symbol?: string
          items?: Json | null
          fetched_at?: string | null
        }
        Relationships: []
      }
      analyst_snapshots: {
        Row: {
          symbol: string
          data: Json | null
          fetched_at: string | null
          last_attempt_at: string | null
          status: string
        }
        Insert: {
          symbol: string
          data?: Json | null
          fetched_at?: string | null
          last_attempt_at?: string | null
          status: string
        }
        Update: {
          symbol?: string
          data?: Json | null
          fetched_at?: string | null
          last_attempt_at?: string | null
          status?: string
        }
        Relationships: []
      }
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
      broker_connections: {
        Row: {
          cash_sync_state: Json | null
          account_id: string | null
          account_summary: Json | null
          api_key_encrypted: string | null
          broker: string
          created_at: string
          environment: string
          id: string
          last_sync_at: string | null
          last_sync_cursor: string | null
          status: string | null
          user_id: string
        }
        Insert: {
          cash_sync_state?: Json | null
          account_id?: string | null
          account_summary?: Json | null
          api_key_encrypted?: string | null
          broker: string
          created_at?: string
          environment?: string
          id?: string
          last_sync_at?: string | null
          last_sync_cursor?: string | null
          status?: string | null
          user_id?: string
        }
        Update: {
          cash_sync_state?: Json | null
          account_id?: string | null
          account_summary?: Json | null
          api_key_encrypted?: string | null
          broker?: string
          created_at?: string
          environment?: string
          id?: string
          last_sync_at?: string | null
          last_sync_cursor?: string | null
          status?: string | null
          user_id?: string
        }
        Relationships: []
      }
      broker_holdings: {
        Row: {
          avg_price_usd: number | null
          broker: string
          id: string
          shares: number
          ticker: string
          updated_at: string | null
          user_id: string
        }
        Insert: {
          avg_price_usd?: number | null
          broker: string
          id?: string
          shares: number
          ticker: string
          updated_at?: string | null
          user_id: string
        }
        Update: {
          avg_price_usd?: number | null
          broker?: string
          id?: string
          shares?: number
          ticker?: string
          updated_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      daily_snapshots: {
        Row: {
          cash_usd: number | null
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
          cash_usd?: number | null
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
          cash_usd?: number | null
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
      deposits: {
        Row: {
          api_reference: string | null
          original_currency: string | null
          original_amount: number | null
          amount_usd: number
          broker: string | null
          broker_account: string | null
          created_at: string | null
          ext_id: string | null
          flow_date: string
          id: string
          source: string | null
          user_id: string
        }
        Insert: {
          api_reference?: string | null
          original_currency?: string | null
          original_amount?: number | null
          amount_usd: number
          broker?: string | null
          broker_account?: string | null
          created_at?: string | null
          ext_id?: string | null
          flow_date: string
          id?: string
          source?: string | null
          user_id: string
        }
        Update: {
          api_reference?: string | null
          original_currency?: string | null
          original_amount?: number | null
          amount_usd?: number
          broker?: string | null
          broker_account?: string | null
          created_at?: string | null
          ext_id?: string | null
          flow_date?: string
          id?: string
          source?: string | null
          user_id?: string
        }
        Relationships: []
      }
      dividends: {
        Row: {
          gross_amount_usd: number | null
          withholding_tax_usd: number | null
          original_currency: string | null
          gross_amount: number | null
          withholding_tax: number | null
          amount_per_share: number
          broker: string
          broker_account: string | null
          cash_delta_applied: number
          created_at: string
          ex_date: string
          ext_id: string | null
          id: string
          pay_date: string | null
          shares_held: number | null
          status: string
          ticker: string
          total_amount_usd: number | null
          user_id: string | null
        }
        Insert: {
          gross_amount_usd?: number | null
          withholding_tax_usd?: number | null
          original_currency?: string | null
          gross_amount?: number | null
          withholding_tax?: number | null
          amount_per_share: number
          broker?: string
          broker_account?: string | null
          cash_delta_applied?: number
          created_at?: string
          ex_date: string
          ext_id?: string | null
          id?: string
          pay_date?: string | null
          shares_held?: number | null
          status?: string
          ticker: string
          total_amount_usd?: number | null
          user_id?: string | null
        }
        Update: {
          gross_amount_usd?: number | null
          withholding_tax_usd?: number | null
          original_currency?: string | null
          gross_amount?: number | null
          withholding_tax?: number | null
          amount_per_share?: number
          broker?: string
          broker_account?: string | null
          cash_delta_applied?: number
          created_at?: string
          ex_date?: string
          ext_id?: string | null
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
      price_history: {
        Row: {
          close: number
          date: string
          symbol: string
        }
        Insert: {
          close: number
          date: string
          symbol: string
        }
        Update: {
          close?: number
          date?: string
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
          user_id: string
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
          user_id?: string
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
          user_id?: string
        }
        Relationships: []
      }
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
          broker: string
          broker_account: string | null
          cash_delta_applied: number
          created_at: string
          executed_at: string
          ext_id: string | null
          fee_usd: number
          id: string
          note: string | null
          price_usd: number
          shares: number
          side: string
          t212_id: string | null
          ticker: string
          user_id: string | null
        }
        Insert: {
          broker?: string
          broker_account?: string | null
          cash_delta_applied?: number
          created_at?: string
          executed_at: string
          ext_id?: string | null
          fee_usd?: number
          id?: string
          note?: string | null
          price_usd: number
          shares: number
          side: string
          t212_id?: string | null
          ticker: string
          user_id?: string | null
        }
        Update: {
          broker?: string
          broker_account?: string | null
          cash_delta_applied?: number
          created_at?: string
          executed_at?: string
          ext_id?: string | null
          fee_usd?: number
          id?: string
          note?: string | null
          price_usd?: number
          shares?: number
          side?: string
          t212_id?: string | null
          ticker?: string
          user_id?: string | null
        }
        Relationships: []
      }
      user_settings: {
        Row: {
          base_currency: string
          confirmed_at: string | null
          created_at: string
          tax_profile: Json
          tax_residence: string
          updated_at: string
          user_id: string
        }
        Insert: {
          base_currency?: string
          confirmed_at?: string | null
          created_at?: string
          tax_profile?: Json
          tax_residence?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          base_currency?: string
          confirmed_at?: string | null
          created_at?: string
          tax_profile?: Json
          tax_residence?: string
          updated_at?: string
          user_id?: string
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
      replace_statement_trades: { Args: { p_account: string | null; p_from: string; p_before: string; p_rows: Json; p_adopt: boolean; p_corrections: Json }; Returns: { inserted: number; corrected: number } }
      begin_agent_request: { Args: { p_request_id: string; p_thread_id: string | null; p_question: string; p_lang: string; p_fingerprint: string; p_execution_token: string }; Returns: Json }
      complete_agent_request: { Args: { p_request_id: string; p_execution_token: string; p_answer: Json; p_metrics: Json }; Returns: undefined }
      apply_cash_delta: { Args: { p_delta: number; p_user_id: string }; Returns: number }
      apply_split: { Args: { split_id: string }; Returns: undefined }
      claim_orphan_data: { Args: { p_email: string }; Returns: Json }
      delete_broker_connection: { Args: { p_broker: string }; Returns: undefined }
      dismiss_split: { Args: { split_id: string }; Returns: undefined }
      get_broker_connection_status: { Args: never; Returns: { account_summary: Json; broker: string; environment: string; last_sync_at: string; status: string }[] }
      get_broker_key: { Args: { p_broker: string; p_user_id: string }; Returns: { api_key: string; environment: string; last_sync_cursor: string }[] }
      guess_sector_for_ticker: { Args: { t: string }; Returns: string }
      import_broker_transactions: { Args: { p_account?: string; p_broker: string; p_recalc?: boolean; p_replace?: boolean; p_rows: Json; p_user_id: string }; Returns: number }
      price_history_coverage: { Args: { p_symbols: string[] }; Returns: { earliest: string; symbol: string }[] }
      recalc_cash:
        | { Args: never; Returns: undefined }
        | { Args: { p_user_id: string }; Returns: undefined }
      recalc_position:
        | { Args: { p_ticker: string }; Returns: undefined }
        | { Args: { p_ticker: string; p_user_id: string }; Returns: undefined }
      reconcile_broker_account: { Args: { p_account: string; p_broker: string; p_holdings: Json; p_note?: string; p_user_id: string }; Returns: number }
      reconcile_broker_to_portfolio: { Args: { p_broker: string; p_holdings: Json; p_user_id: string }; Returns: undefined }
      set_broker_connection: { Args: { p_broker: string; p_env: string; p_key: string }; Returns: Json }
      transaction_cash_delta: { Args: { p_fee_usd: number; p_price_usd: number; p_shares: number; p_side: string; p_ticker: string }; Returns: number }
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
