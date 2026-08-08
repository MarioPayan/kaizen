import { Toast } from '@base-ui/react/toast';
import type { ReactNode } from 'react';

/**
 * Action feedback.
 *
 * Approving a cluster changes seven files at once with no visible result on the
 * page — the row does not move and nothing navigates. Without an acknowledgement
 * the only way to know it worked is to go looking, so the confirmation says what
 * actually happened, including the count.
 */

export function ToastProvider({ children }: { children: ReactNode }) {
  return (
    <Toast.Provider>
      {children}
      <Toast.Portal>
        <Toast.Viewport className="fixed right-4 bottom-4 z-50 flex w-80 flex-col gap-2">
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      className="border border-line bg-surface px-3 py-2 shadow-lg transition-all duration-200 data-[ending-style]:translate-x-4 data-[ending-style]:opacity-0 data-[starting-style]:translate-x-4 data-[starting-style]:opacity-0"
    >
      <Toast.Title className="font-mono text-xs font-bold text-ink" />
      <Toast.Description className="mt-0.5 text-xs text-ink-2" />
      <Toast.Close
        aria-label="Dismiss"
        className="absolute top-1.5 right-2 font-mono text-xs text-ink-3 hover:text-ink"
      >
        ×
      </Toast.Close>
    </Toast.Root>
  ));
}

export function useToast() {
  const manager = Toast.useToastManager();
  return {
    ok: (title: string, description?: string) => manager.add({ title, description, timeout: 4000 }),
    fail: (title: string, description?: string) => manager.add({ title, description, timeout: 8000 }),
  };
}
