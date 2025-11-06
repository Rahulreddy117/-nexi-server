Parse.Cloud.define("updateLocation", async (request) => {
  const { userId, latitude, longitude } = request.params;

  if (!userId || !latitude || !longitude) {
    throw new Error("Missing parameters");
  }

  const UserProfile = Parse.Object.extend("UserProfile");
  const query = new Parse.Query(UserProfile);
  query.equalTo("objectId", userId);

  const user = await query.first({ useMasterKey: true });
  if (!user) throw new Error("User not found");

  // ✅ Store location in GeoJSON (MongoDB compatible)
  user.set("location", {
    type: "Point",
    coordinates: [longitude, latitude],
  });

  await user.save(null, { useMasterKey: true });
  return { success: true };
});


// ✅ Query nearby users using Parse's built-in geo query
Parse.Cloud.define("getNearbyUsers", async (request) => {
  const { latitude, longitude, maxDistance = 20 } = request.params;

  if (!latitude || !longitude) {
    throw new Error("Missing coordinates");
  }

  const UserProfile = Parse.Object.extend("UserProfile");
  const query = new Parse.Query(UserProfile);

  // Convert 20m → km
  const distanceKm = maxDistance / 1000;

  query.withinKilometers(
    "location",
    new Parse.GeoPoint(latitude, longitude),
    distanceKm
  );

  const users = await query.find({ useMasterKey: true });

  return users.map((u) => ({
    id: u.id,
    name: u.get("name"),
    username: u.get("username"),
    profilePicUrl: u.get("profilePicUrl"),
    location: u.get("location"),
  }));
});
