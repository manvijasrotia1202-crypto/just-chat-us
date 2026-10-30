(() => {
  const socket = io();
  const $ = (id) => document.getElementById(id);

  const entryScreen = $("entry-screen");
  const chatScreen = $("chat-screen");
  const nameInput = $("display-name");
  const entryError = $("entry-error");
  const createPanel = $("create-panel");
  const joinPanel = $("join-panel");
  const createButton = $("create-room");
  const joinButton = $("join-room");
  const inviteBox = $("invite-box");
  const inviteLink = $("invite-link");
  const copyLink = $("copy-link");
  const roomStatus = $("room-status");
  const messages = $("messages");
  const emptyState = $("empty-state");
  const messageInput = $("message-input");
  const sendButton = $("send-button");
  const photoInput = $("photo-input");
  const photoPreview = $("photo-preview");
  const previewImage = $("preview-image");
  const previewName = $("preview-name");
  const removePhoto = $("remove-photo");
  const replyPreview = $("reply-preview");
  const replyName = $("reply-name");
  const replyText = $("reply-text");
  const cancelReply = $("cancel-reply");
  const toast = $("toast");

  let roomId = null;
  let inviteToken = null;
  let myName = "";
  let mySocketId = null;
  let roomKey = null;
  let replyTarget = null;
  let selectedPhoto = null;
  let toastTimer = null;
  let roomExpired = false;
  let renderingQueue = Promise.resolve();

  $("year").textContent = new Date().getFullYear();

  const params = new URLSearchParams(window.location.search);
  const incomingRoom = params.get("room");
  const incomingToken = params.get("invite");
  const incomingKey = new URLSearchParams(window.location.hash.slice(1)).get("key");
  if (incomingRoom && incomingToken && incomingKey) {
    createPanel.hidden = true;
    joinPanel.hidden = false;
  }

  function showError(message) {
    entryError.textContent = message;
    entryError.hidden = false;
  }
  function clearError() {
    entryError.textContent = "";
    entryError.hidden = true;
  }
  function notify(message) {
    toast.textContent = message;
    toast.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("visible"), 2800);
  }
  function setBusy(button, busy) {
    button.disabled = busy;
    button.dataset.oldText ||= button.innerHTML;
    button.innerHTML = busy ? "Connecting…" : button.dataset.oldText;
  }
  function showChat() {
    entryScreen.hidden = true;
    chatScreen.hidden = false;
    messageInput.focus();
  }
  function showEntry(message) {
    chatScreen.hidden = true;
    entryScreen.hidden = false;
    createPanel.hidden = Boolean(incomingRoom && incomingToken && incomingKey);
    joinPanel.hidden = !(incomingRoom && incomingToken && incomingKey);
    if (message) showError(message);
  }
  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  function appendNotice(text) {
    const node = document.createElement("div");
    node.className = "room-notice";
    node.textContent = text;
    messages.appendChild(node);
    scrollToBottom();
  }
  function scrollToBottom() {
    messages.scrollTop = messages.scrollHeight;
  }
  function updateEmptyState() {
    emptyState.hidden = Boolean(messages.querySelector(".message-row"));
  }

  function bytesToBase64Url(bytes) {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }
  function base64UrlToBytes(value) {
    if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid key format.");
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
    const binary = atob(base64);
    return Uint8Array.from(binary, (char) => char.charCodeAt(0));
  }
  async function createRoomKey() {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    const key = await crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
    return { key, encoded: bytesToBase64Url(raw) };
  }
  async function importRoomKey(encoded) {
    const raw = base64UrlToBytes(encoded);
    if (raw.length !== 32) throw new Error("This invitation has an invalid encryption key.");
    return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
  }
  function additionalData(messageId, senderId, createdAt) {
    return new TextEncoder().encode(`${roomId}|${messageId}|${senderId}|${createdAt}`);
  }
  async function encryptPayload(payload, id, senderId, createdAt) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plain = new TextEncoder().encode(JSON.stringify(payload));
    const encrypted = await crypto.subtle.encrypt({
      name: "AES-GCM",
      iv,
      additionalData: additionalData(id, senderId, createdAt),
      tagLength: 128
    }, roomKey, plain);
    return { iv: bytesToBase64Url(iv), ciphertext: bytesToBase64Url(new Uint8Array(encrypted)) };
  }
  async function decryptMessage(message) {
    const iv = base64UrlToBytes(message.iv);
    const ciphertext = base64UrlToBytes(message.ciphertext);
    if (iv.length !== 12) throw new Error("Invalid encrypted message.");
    const plain = await crypto.subtle.decrypt({
      name: "AES-GCM",
      iv,
      additionalData: additionalData(message.id, message.senderId, message.createdAt),
      tagLength: 128
    }, roomKey, ciphertext);
    return JSON.parse(new TextDecoder().decode(plain));
  }

  async function renderMessage(message) {
    const row = document.createElement("article");
    row.className = "message-row" + (message.senderId === mySocketId ? " mine" : "");
    row.dataset.messageId = message.id;

    const meta = document.createElement("div");
    meta.className = "message-meta";
    const sender = document.createElement("strong");
    sender.textContent = message.senderId === mySocketId ? "You" : message.senderName;
    const time = document.createElement("span");
    time.textContent = formatTime(message.createdAt);
    meta.append(sender, time);

    const bubble = document.createElement("div");
    bubble.className = "bubble";
    let content;
    try {
      content = await decryptMessage(message);
    } catch {
      const warning = document.createElement("div");
      warning.textContent = "Couldn't decrypt this message. The key may not match.";
      warning.className = "decrypt-warning";
      bubble.appendChild(warning);
      row.append(meta, bubble);
      messages.appendChild(row);
      updateEmptyState();
      scrollToBottom();
      return;
    }

    if (content.replyTo) {
      const quote = document.createElement("div");
      quote.className = "reply-quote";
      const quotedSender = document.createElement("strong");
      quotedSender.textContent = content.replyTo.senderName;
      const quotedText = document.createElement("span");
      quotedText.textContent = content.replyTo.text;
      quote.append(quotedSender, quotedText);
      bubble.appendChild(quote);
    }

    if (content.text) {
      const text = document.createElement("div");
      text.textContent = content.text;
      bubble.appendChild(text);
    }
    if (content.photo && content.photo.dataUrl) {
      const img = document.createElement("img");
      img.src = content.photo.dataUrl;
      img.alt = "End-to-end encrypted photo shared in this room";
      img.loading = "lazy";
      bubble.appendChild(img);
    }

    const actions = document.createElement("div");
    actions.className = "message-actions";
    const replyButton = document.createElement("button");
    replyButton.className = "reply-button";
    replyButton.type = "button";
    replyButton.textContent = "↶ Reply";
    replyButton.addEventListener("click", () => setReply({
      id: message.id,
      senderName: message.senderName,
      text: content.text || (content.photo ? "📷 Photo" : "Message")
    }));
    actions.appendChild(replyButton);

    row.append(meta, bubble, actions);
    messages.appendChild(row);
    updateEmptyState();
    scrollToBottom();
  }

  function queueRender(message) {
    renderingQueue = renderingQueue.then(async () => {
      if (!roomId || roomExpired) return;
      if (messages.querySelector(`[data-message-id="${CSS.escape(message.id)}"]`)) return;
      await renderMessage(message);
    }).catch(() => notify("A message couldn't be displayed."));
  }

  function setReply(message) {
    replyTarget = message;
    replyName.textContent = message.senderName;
    replyText.textContent = message.text || "Message";
    replyPreview.hidden = false;
    messageInput.focus();
  }
  function clearReply() {
    replyTarget = null;
    replyPreview.hidden = true;
  }
  function clearSelectedPhoto() {
    selectedPhoto = null;
    photoInput.value = "";
    previewImage.removeAttribute("src");
    photoPreview.hidden = true;
  }
  function resetChat() {
    roomId = null;
    inviteToken = null;
    mySocketId = null;
    roomKey = null;
    roomExpired = true;
    messages.querySelectorAll(".message-row, .room-notice").forEach((node) => node.remove());
    updateEmptyState();
    inviteBox.hidden = true;
    clearReply();
    clearSelectedPhoto();
    messageInput.value = "";
    roomStatus.textContent = "Room closed";
  }

  async function createRoom() {
    clearError();
    myName = nameInput.value.trim();
    if (!myName) return showError("Enter a display name first.");
    if (!window.crypto?.subtle) return showError("Secure browser encryption isn't available. Open this page on HTTPS or localhost.");
    setBusy(createButton, true);
    try {
      const generated = await createRoomKey();
      socket.emit("room:create", { name: myName }, (result) => {
        setBusy(createButton, false);
        if (!result?.ok) return showError(result?.error || "Couldn't create the room.");
        roomId = result.roomId;
        inviteToken = result.inviteToken;
        roomKey = generated.key;
        mySocketId = socket.id;
        roomExpired = false;
        const url = new URL(window.location.href);
        url.search = "";
        url.searchParams.set("room", roomId);
        url.searchParams.set("invite", inviteToken);
        url.hash = `key=${generated.encoded}`;
        inviteLink.value = url.toString();
        inviteBox.hidden = false;
        roomStatus.innerHTML = '<span class="status-dot"></span> Waiting for your person';
        showChat();
        // The fragment stays in the invitation input, but not in the active page URL.
        history.replaceState({}, "", url.pathname + url.search);
        notify("Encrypted room created. Send the full invitation link.");
      });
    } catch {
      setBusy(createButton, false);
      showError("Couldn't create an encryption key in this browser.");
    }
  }

  async function joinRoom() {
    clearError();
    myName = nameInput.value.trim();
    if (!myName) return showError("Enter a display name first.");
    if (!incomingRoom || !incomingToken || !incomingKey) return showError("This invitation is missing its room key.");
    if (!window.crypto?.subtle) return showError("Secure browser encryption isn't available. Open this page on HTTPS or localhost.");
    setBusy(joinButton, true);
    try {
      const importedKey = await importRoomKey(incomingKey);
      socket.emit("room:join", {
        name: myName,
        roomId: incomingRoom,
        inviteToken: incomingToken
      }, async (result) => {
        setBusy(joinButton, false);
        if (!result?.ok) return showError(result?.error || "Couldn't join the room.");
        roomId = result.roomId;
        roomKey = importedKey;
        mySocketId = socket.id;
        roomExpired = false;
        inviteBox.hidden = true;
        messages.querySelectorAll(".message-row, .room-notice").forEach((node) => node.remove());
        for (const message of (result.messages || [])) {
          await renderMessage(message);
        }
        updateEmptyState();
        roomStatus.innerHTML = '<span class="status-dot"></span> Connected to your person';
        showChat();
        history.replaceState({}, "", window.location.pathname);
      });
    } catch {
      setBusy(joinButton, false);
      showError("Couldn't read the encryption key from this invitation.");
    }
  }

  async function sendMessage() {
    if (!roomId || roomExpired || !roomKey) return notify("This room has ended. Create a new one.");
    const text = messageInput.value.trim();
    if (!text && !selectedPhoto) return;
    sendButton.disabled = true;
    try {
      const idBytes = crypto.getRandomValues(new Uint8Array(18));
      const id = bytesToBase64Url(idBytes);
      const createdAt = Date.now();
      const payload = {
        text,
        photo: selectedPhoto,
        replyTo: replyTarget ? {
          id: replyTarget.id,
          senderName: replyTarget.senderName,
          text: replyTarget.text || "Message"
        } : null
      };
      const encrypted = await encryptPayload(payload, id, socket.id, createdAt);
      socket.emit("message:send", {
        id,
        createdAt,
        iv: encrypted.iv,
        ciphertext: encrypted.ciphertext
      }, (result) => {
        sendButton.disabled = false;
        if (!result?.ok) {
          notify(result?.error || "Message couldn't be sent.");
          return;
        }
        messageInput.value = "";
        autoResize();
        clearReply();
        clearSelectedPhoto();
      });
    } catch {
      sendButton.disabled = false;
      notify("Couldn't encrypt this message. Try again.");
    }
  }

  function autoResize() {
    messageInput.style.height = "auto";
    messageInput.style.height = Math.min(messageInput.scrollHeight, 130) + "px";
  }

  async function choosePhoto(file) {
    if (!file) return;
    const allowed = ["image/jpeg", "image/png", "image/webp", "image/gif"];
    if (!allowed.includes(file.type)) {
      photoInput.value = "";
      return notify("Choose a JPG, PNG, WebP or GIF image.");
    }
    if (file.size > 1024 * 1024) {
      photoInput.value = "";
      return notify("That photo is too large. Maximum size is 1 MiB.");
    }
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Couldn't read that photo."));
        reader.readAsDataURL(file);
      });
      selectedPhoto = { dataUrl, type: file.type };
      previewImage.src = dataUrl;
      previewName.textContent = file.name;
      photoPreview.hidden = false;
    } catch {
      notify("Couldn't read that photo.");
    }
  }

  createButton.addEventListener("click", createRoom);
  joinButton.addEventListener("click", joinRoom);
  sendButton.addEventListener("click", sendMessage);
  cancelReply.addEventListener("click", clearReply);
  removePhoto.addEventListener("click", clearSelectedPhoto);
  photoInput.addEventListener("change", () => choosePhoto(photoInput.files?.[0]));
  messageInput.addEventListener("input", autoResize);
  messageInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
    }
  });

  copyLink.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(inviteLink.value);
      notify("Invitation link copied.");
    } catch {
      inviteLink.focus();
      inviteLink.select();
      notify("Select and copy the invitation link.");
    }
  });

  $("leave-room").addEventListener("click", () => {
    socket.disconnect();
    resetChat();
    showEntry("You've left the room. Create a new one to chat again.");
    socket.connect();
  });

  socket.on("connect", () => {
    mySocketId = socket.id;
  });
  socket.on("disconnect", () => {
    if (roomId && !roomExpired) {
      roomStatus.textContent = "Connection lost · reconnecting…";
      notify("Connection lost. If the room was empty, it may be cleared shortly.");
    }
  });
  socket.on("message:new", (message) => {
    if (!roomId || roomExpired) return;
    queueRender(message);
  });
  socket.on("room:members", ({ count }) => {
    if (!roomId || roomExpired) return;
    roomStatus.innerHTML = count >= 2
      ? '<span class="status-dot"></span> Both of you are here'
      : '<span class="status-dot"></span> Waiting for your person';
  });
  socket.on("room:notice", ({ text }) => {
    if (roomId && !roomExpired) appendNotice(text);
  });
  socket.on("room:ended", ({ message }) => {
    if (!roomId || roomExpired) return;
    resetChat();
    notify(message || "This room has ended.");
    showEntry(message || "This room has ended. Create a new room to start again.");
  });
})();
