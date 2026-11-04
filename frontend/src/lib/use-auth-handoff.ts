import { useLayoutEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { isExternalHttpTarget } from "./post-login-redirect";

/** Keep the submitting step locked until it leaves, and ignore late replies after Back. */
export function useAuthHandoff() {
  const navigate = useNavigate();
  const active = useRef(true);
  useLayoutEffect(() => {
    active.current = true;
    return () => { active.current = false; };
  }, []);

  return {
    canRetry: () => active.current,
    go(destination: string) {
      if (!active.current) return;
      if (isExternalHttpTarget(destination)) window.location.replace(destination);
      else navigate(destination, { replace: true });
      active.current = false;
    },
  };
}
