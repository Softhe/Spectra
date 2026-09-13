import { createFileRoute } from "@tanstack/react-router";
import { Analyzer } from "@/components/analyzer";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <Analyzer />;
}
