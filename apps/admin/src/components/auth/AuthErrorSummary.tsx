import { forwardRef } from "react";

interface AuthErrorSummaryProps {
  message: string;
}

export const AuthErrorSummary = forwardRef<HTMLDivElement, AuthErrorSummaryProps>(
  function AuthErrorSummary({ message }, ref) {
    return (
      <div
        ref={ref}
        className="admin-inline-error"
        role="alert"
        tabIndex={-1}
      >
        {message}
      </div>
    );
  },
);
