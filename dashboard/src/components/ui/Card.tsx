import type { ReactNode } from "react";

interface CardProps {
  className?: string;
  children: ReactNode;
}

export function Card({ className = "", children }: CardProps) {
  return (
    <section
      className={`rounded-2xl border border-slate-200/90 bg-white shadow-card ${className}`}
    >
      {children}
    </section>
  );
}

interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}

export function CardHeader({ title, description, actions }: CardHeaderProps) {
  return (
    <div className="flex flex-col gap-3 border-b border-slate-200/80 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold text-slate-900">{title}</h2>
        {description === undefined ? null : (
          <p className="mt-1 text-sm leading-5 text-slate-600">{description}</p>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      )}
    </div>
  );
}

interface CardBodyProps {
  className?: string;
  children: ReactNode;
}

export function CardBody({ className = "", children }: CardBodyProps) {
  return <div className={`px-5 py-4 ${className}`}>{children}</div>;
}
