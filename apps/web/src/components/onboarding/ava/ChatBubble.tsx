import ReactMarkdown from 'react-markdown';
import { Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ChatMessage } from '@/types/onboarding';

/** Bolha da conversa: Ava à esquerda (com avatar), usuário à direita. */
export function ChatBubble({ message }: { message: ChatMessage }) {
  const isAva = message.from === 'ava';
  return (
    <div className={cn('flex w-full items-end gap-2', isAva ? 'justify-start' : 'justify-end')}>
      {isAva && (
        <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-sky-500 shadow-lg shadow-indigo-500/20">
          <Sparkles className="h-4 w-4 text-white" />
        </div>
      )}
      <div
        className={cn(
          'max-w-[78%] rounded-2xl px-4 py-3 text-sm leading-6 shadow-sm [&_p]:my-1.5 [&_p]:leading-6',
          isAva
            ? 'rounded-tl-sm border border-white/10 bg-white/[0.06] text-slate-100'
            : 'rounded-tr-sm bg-indigo-500 font-medium text-white shadow-indigo-500/20 [&_strong]:font-bold'
        )}
      >
        {/* Respostas da Ava usam markdown (**negrito**, listas); \n vira bloco. */}
        {(message.text ?? '').split('\n').map((line, i) => (
          <ReactMarkdown key={i}>{line}</ReactMarkdown>
        ))}
      </div>
    </div>
  );
}
