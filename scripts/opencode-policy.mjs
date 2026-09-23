// Loaded only by the owned private beta server. Never installs into user config.
export default {
  id: "asf-no-retry",
  async setup(context) {
    const retry = await context.session.hook("retry", (event) => {
      event.decision = { retry: false };
    });
    return () => retry.dispose();
  },
};
