import type { ErrorComponentProps } from "@tanstack/react-router";
import { TriangleAlert } from "lucide-react";

const FALLBACK_MESSAGE = "An unexpected error occurred. Try reloading the page.";

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return FALLBACK_MESSAGE;
}

// Rendered on the app's own dark tokens so a crash doesn't flash a white
// page inside an otherwise dark document. error.message stays visible — it
// is what turns a blank screen into a reportable bug.
export function AppErrorComponent({ error }: ErrorComponentProps) {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-3 bg-bg px-6 text-center text-fg">
      <span className="text-loss" aria-hidden>
        <TriangleAlert className="size-10" strokeWidth={2} />
      </span>
      <h1 className="text-lg font-medium">Something went wrong</h1>
      <p className="max-w-md text-sm break-words text-muted">
        {errorMessage(error)}
      </p>
    </main>
  );
}
