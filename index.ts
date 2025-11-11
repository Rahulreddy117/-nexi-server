// AUTO-CREATE Message CLASS (CLEAN & PROFESSIONAL)
(async () => {
  try {
    const schema = new Parse.Schema("Message");

    // Try to create class
    await schema.save();
    console.log("Message class created");

    // Set permissions
    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { requiresAuthentication: true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
      addField: { requiresAuthentication: true },
    });
    await schema.update();
    console.log("Message permissions set");

  } catch (err: any) {
    if (err.code === 103) {
      console.log("Message class already exists (perfect!)");
      // Optionally update permissions
      try {
        const schema = new Parse.Schema("Message");
        schema.setCLP({ /* your CLP */ });
        await schema.update();
      } catch (updateErr) {
        // Ignore — non-critical
      }
    } else {
      console.error("Unexpected schema error:", err);
    }
  }
})();
