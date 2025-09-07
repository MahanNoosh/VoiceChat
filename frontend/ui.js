// Populate the room select dropdown with defaults and saved selection
function populateRooms() {
    const select = document.getElementById("roomSelect");
    const rooms = ["Room A", "Room B", "Room C"];
  
    // Build options
    select.innerHTML = "";
    rooms.forEach(room => {
      const opt = document.createElement("option");
      opt.value = room;
      opt.textContent = room;
      select.appendChild(opt);
    });
  
    // Restore saved room or use default
    const savedRoom = Storage.load("room", rooms[0]);
    select.value = rooms.includes(savedRoom) ? savedRoom : rooms[0];
  
    // Save room selection when changed
    select.addEventListener("change", () => {
      Storage.save("room", select.value);
    });
  }
  
  // Restore previously saved username and microphone gain settings
  function restoreSettings() {
    const usernameEl = document.getElementById("username");
    const gainEl = document.getElementById("gainControl");
  
    usernameEl.value = Storage.load("username", "");
    gainEl.value = Storage.load("micVolume", 1);
  
    usernameEl.addEventListener("input", () => {
      Storage.save("username", usernameEl.value.trim());
    });
  
    gainEl.addEventListener("input", () => {
      Storage.save("micVolume", Number(gainEl.value));
    });
  }
  
  // Append a log message to the status box with timestamp
  function logStatus(msg) {
    const statusEl = document.getElementById("status");
    const time = new Date().toLocaleTimeString();
    
    const entry = document.createElement("div");
    entry.textContent = `${time} — ${msg}`;
    
    statusEl.appendChild(entry);
    statusEl.scrollTop = statusEl.scrollHeight;
    
    // Also log to console for debugging
    console.log(`${time} — ${msg}`);
  }
  