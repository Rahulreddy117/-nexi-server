// AUTO-CREATE Message CLASS (OPTIMIZED)
(async () => {
  try {
    const schema = new Parse.Schema("Message");

    // Set CLP first
    schema.setCLP({
      get: { requiresAuthentication: true },
      find: { requiresAuthentication: true },
      create: { requiresAuthentication: true },
      update: { requiresAuthentication: true },
      delete: { requiresAuthentication: true },
      addField: { requiresAuthentication: true },
    });

    // Define fields
    await schema
      .addString("senderId")
      .addString("receiverId")
      .addString("text")
      .addDate("expiresAt");

    // Save (creates if not exists)
    await schema.save();
    console.log("Message class ensured with CLP");

  } catch (err: any) {
    if (err.code === 103) {
      console.log("Message class already exists");
      // Optionally force-update CLP
      try {
        const schema = new Parse.Schema("Message");
        schema.setCLP({ /* same CLP */ });
        await schema.update();
        console.log("CLP updated");
      } catch {}
    } else {
      console.error("Schema error:", err);
    }
  }
})();
