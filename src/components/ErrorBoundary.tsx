import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    hasError: false,
    message: '',
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    let readable = error?.message || 'Beklenmeyen bir hata oluştu.';
    try {
      const parsed = JSON.parse(readable) as { error?: string; operationType?: string };
      if (parsed && typeof parsed.error === 'string') {
        readable = `Bulut senkronizasyon hatası (${parsed.operationType || 'işlem'}): ${parsed.error}`;
      }
    } catch {
      // keep raw message
    }
    return { hasError: true, message: readable };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[IPFLIX ErrorBoundary]', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <div className="min-h-screen bg-[#08090D] text-[#F5F7FA] flex items-center justify-center p-6">
        <div className="w-full max-w-md rounded-2xl bg-[#12141B] border border-white/10 p-7 text-center space-y-5 shadow-2xl">
          <div className="w-12 h-12 rounded-xl bg-[#E50914]/15 border border-[#E50914]/35 text-[#E50914] flex items-center justify-center mx-auto">
            <AlertTriangle className="w-6 h-6" />
          </div>
          <div className="space-y-2">
            <h1 className="font-display text-xl font-bold text-white">
              IPFLIX Bir Hata ile Karşılaştı
            </h1>
            <p className="text-xs text-[#9CA3B2] leading-relaxed break-words">
              {this.state.message}
            </p>
            <p className="text-[11px] text-[#6E7688]">
              Yerel verileriniz ve IPTV hesaplarınız güvenle saklanmaktadır.
            </p>
          </div>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="w-full min-h-[44px] px-4 py-2.5 rounded-lg bg-[#E50914] hover:bg-[#F6121D] text-sm font-semibold text-white inline-flex items-center justify-center gap-2 transition-colors"
          >
            <RefreshCw className="w-4 h-4" />
            <span>Uygulamayı Yenile</span>
          </button>
        </div>
      </div>
    );
  }
}
