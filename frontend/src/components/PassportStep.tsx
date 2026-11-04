import EntryTransition from "./EntryTransition";
import { useLayoutEffect, useRef, type ReactNode } from "react";
import { useNavigationType } from "react-router-dom";

export default function PassportStep({ title, description, progress, children }: {
  title: string;
  description?: ReactNode;
  progress?: ReactNode;
  children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const navigation = useNavigationType();
  useLayoutEffect(() => {
    if (navigation === "POP") return;
    heading.current?.focus({ preventScroll: true });
    // A link can be activated from the bottom of the home or registration page.
    if (heading.current && heading.current.getBoundingClientRect().top < 0) {
      heading.current.scrollIntoView({ block: "start", behavior: "instant" });
    }
  }, [navigation, title]);

  return <EntryTransition default="none" exit="auth-depart">
    <section className="passport-step route-arrival">
      {progress}
      <div className="auth-intro">
        <h1 ref={heading} tabIndex={-1}>{title}</h1>
        {description && <div className="auth-description">{description}</div>}
      </div>
      <div className="auth-card">{children}</div>
    </section>
  </EntryTransition>;
}
