'use client';

import posthog from 'posthog-js';
import { ReactNode, useEffect } from 'react';
import { PostHogProvider } from 'posthog-js/react';
import { TELEMETRY_DECISION_KEY, TELEMETRY_OPT_OUT_KEY } from '@/utils/telemetry';
import { getAppVersion } from '@/utils/version';

// Returns true if PostHog should be opted-out at boot time, before settings
// have loaded. Honors any explicit decision the user has made; otherwise
// returns true (opt-out by default) so brand-new users never ping PostHog
// before Providers can finalize the decision. Existing users whose settings
// have telemetry enabled are re-opted-in once Providers loads their settings.
const shouldOptOutAtBoot = () => {
  if (typeof window === 'undefined') return true;
  const decision = localStorage.getItem(TELEMETRY_DECISION_KEY);
  if (decision === 'opt-in') return false;
  if (decision === 'opt-out' || decision === 'pending') return true;
  return localStorage.getItem(TELEMETRY_OPT_OUT_KEY) !== 'false';
};

// Readest Remote never falls back to Readest's embedded analytics project.
// Telemetry can only be enabled by a future Remote-owned build that provides
// both values explicitly.
const posthogUrl = process.env['NEXT_PUBLIC_REMOTE_POSTHOG_HOST'];
const posthogKey = process.env['NEXT_PUBLIC_REMOTE_POSTHOG_KEY'];

if (
  typeof window !== 'undefined' &&
  process.env['NODE_ENV'] === 'production' &&
  posthogKey &&
  posthogUrl
) {
  posthog.init(posthogKey, {
    api_host: posthogUrl,
    person_profiles: 'always',
    autocapture: false,
    opt_out_capturing_by_default: shouldOptOutAtBoot(),
  });
}
export const CSPostHogProvider = ({ children }: { children: ReactNode }) => {
  useEffect(() => {
    posthog.register_for_session({
      $app_version: getAppVersion(),
    });
  }, []);
  return <PostHogProvider client={posthog}>{children}</PostHogProvider>;
};
