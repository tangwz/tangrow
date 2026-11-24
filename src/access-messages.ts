const errors: Record<string, string> = {
  invalid_code: 'Check your redemption code and try again.',
  device_limit: 'Device limit reached.',
  revoked: 'This redemption code has been revoked.',
  rate_limited: 'Too many requests. Try again later.',
  storage: 'Tangrow could not save access on this device.',
  unavailable: 'The trial is unavailable on this device.',
  no_lease: 'There is no activation to renew or release on this device.',
  activation_in_progress: 'An activation is already in progress. Wait for it to finish before trying again.',
  release_first: 'To use a different redemption code, release this device in Activation and updates first.',
  reactivate_required: 'In Activation and updates, release this device and enter your original redemption code to reactivate it.',
  timeout: 'The activation service timed out. Try again.',
  upstream_unavailable: 'The activation service is temporarily unavailable. Try again later.',
  request_failed: 'Could not reach the activation service. Check your connection and try again.',
  invalid_response: 'The activation service returned an unexpected response.',
  bad_request: 'The activation service rejected the request.',
  stale: 'Access changed during the request. Try again.',
  owner_build: 'This owner build does not use activation.'
};

export function accessErrorMessage(error: string): string {
  return errors[error] ?? 'Access could not be updated.';
}
