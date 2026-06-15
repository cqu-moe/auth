import type { ReactNode } from "react";

// Centered modal shell with backdrop.
export function Modal({
  onClose,
  children,
  maxWidth = "max-w-2xl",
}: {
  onClose: () => void;
  children: ReactNode;
  maxWidth?: string;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        className={`relative w-full ${maxWidth} max-h-[90vh] overflow-y-auto bg-white rounded-2xl border border-gray-200 shadow-xl`}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
}
