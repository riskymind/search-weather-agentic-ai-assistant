import { BrandMark } from "@/components/BrandMark";
import { SuggestedPrompts } from "@/components/SuggestedPrompts";

interface WelcomeScreenProps {
  onSelectPrompt: (prompt: string) => void;
  disabled?: boolean;
}

export function WelcomeScreen({ onSelectPrompt, disabled }: WelcomeScreenProps) {
  return (
    <section className="mx-auto flex w-full max-w-[760px] flex-1 flex-col justify-center px-4 py-10 sm:px-6">
      <BrandMark className="size-11" />
      <h1 className="mt-6 font-display text-[clamp(2rem,5.5vw,3.25rem)] leading-[1.04] font-semibold tracking-tight">
        What would you like to know?
      </h1>
      <p className="mt-3 max-w-[58ch] text-base leading-relaxed text-muted">
        I search the web for current information and check live weather for any city. Ask a question,
        or start with one of these.
      </p>
      <div className="mt-8">
        <SuggestedPrompts onSelect={onSelectPrompt} disabled={disabled} />
      </div>
    </section>
  );
}
