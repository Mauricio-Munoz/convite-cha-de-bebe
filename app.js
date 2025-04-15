// Arquivo: app.js
// Contém a lógica Model-View-Controller da aplicação Chá de Bebê.
// Assume que firebase-config.js já foi carregado e definiu a variável firebaseConfig.
// Assume que os SDKs do Firebase já foram carregados no index.html.

// --- Inicializar Firebase ---
let db, auth, googleProvider;
try {
    // Verifica se firebaseConfig foi carregado do arquivo externo
    if (typeof firebaseConfig === 'undefined') {
        throw new Error("Variável firebaseConfig não encontrada. Verifique se firebase-config.js foi carregado corretamente ANTES de app.js.");
    }
    
    // Inicializa o Firebase com a configuração
    firebase.initializeApp(firebaseConfig);
    
    // Inicializa os serviços Firebase
    db = firebase.firestore();
    auth = firebase.auth();
    googleProvider = new firebase.auth.GoogleAuthProvider();
    
    console.log("Firebase inicializado com sucesso."); // Log de sucesso
} catch (e) {
    console.error("Erro Firebase Init:", e);
    alert("Erro crítico na configuração da aplicação.");
    
    // Tenta mostrar erro na UI se a View já estiver definida (pode não estar ainda)
    if(typeof View !== 'undefined' && View.showEventLoadError) {
        View.showEventLoadError(`Erro Init Firebase: ${e.message}`);
        View.hideLoading();
    } else {
        // Fallback se a View não estiver pronta
        document.body.innerHTML = `<p style="color:red; padding: 20px;">Erro crítico ao inicializar Firebase: ${e.message}</p>`;
    }
    
    // Impede a execução do resto do script se a inicialização falhar
    throw new Error("Falha na inicialização do Firebase.");
}

// --- MODEL ---
// Responsável pelos dados e interação com o Firestore/Auth
const Model = {
    currentEventId: null, // ID do evento carregado da URL
    appConfig: null,      // Config do evento atual
    giftDataCache: [],    // Cache de presentes do evento atual
    currentUser: null,
    isAdmin: false,
    currentRsvpData: null,
    currentRsvpDocId: null,

    // --- Configuração do Evento (Agora por Event ID) ---
    async loadEventConfig(eventId) {
        console.log(`Model: Carregando config ${eventId}...`);
        if (!eventId) throw new Error("ID Evento não fornecido.");
        this.currentEventId = eventId; // Armazena o ID atual
        const docRef = db.collection('events').doc(eventId); // Caminho alterado
        const docSnap = await docRef.get();
        if (docSnap.exists) {
            this.appConfig = docSnap.data();
            // Tratamento de data mais robusto com log específico
            const rawEventDate = this.appConfig.eventDate; // Guarda valor bruto
            try {
                if (rawEventDate?.toDate) { // Verifica se tem o método toDate()
                    const convertedDate = rawEventDate.toDate();
                    if (convertedDate instanceof Date && !isNaN(convertedDate)) {
                        this.appConfig.eventDate = convertedDate;
                    } else {
                        console.warn(`Model: toDate() resultou em data inválida para evento ${eventId}. Valor lido:`, rawEventDate);
                        this.appConfig.eventDate = null; // Define como null se inválida
                    }
                } else {
                     console.warn(`Model: Campo eventDate não é timestamp ou não existe para evento ${eventId}. Tipo: ${typeof rawEventDate}`);
                     this.appConfig.eventDate = null; // Define como null se não for timestamp
                }
            } catch (dateError) {
                 console.error(`Model: Erro EXATO ao converter eventDate para evento ${eventId}:`, dateError);
                 this.appConfig.eventDate = null; // Define como null em caso de erro
            }
            if (!Array.isArray(this.appConfig.adminUids)) this.appConfig.adminUids = [];
            console.log("Model: Config carregada", this.appConfig); // Log do objeto carregado
            this.checkAdminStatus(); return this.appConfig;
        } else { throw new Error(`Evento ID '${eventId}' não encontrado!`); }
    },

    async saveEventConfig(updatedConfigData) {
        console.log(`Model: Salvando config para evento ${this.currentEventId}...`);
        if (!this.isAdmin || !this.currentEventId) throw new Error("Acesso negado ou evento não carregado.");
        if (updatedConfigData.eventDate instanceof Date) {
            updatedConfigData.eventDate = firebase.firestore.Timestamp.fromDate(updatedConfigData.eventDate);
        }
        // Garante que adminUids é um array de strings não vazias
         if (updatedConfigData.adminUids && typeof updatedConfigData.adminUids === 'string') {
             updatedConfigData.adminUids = updatedConfigData.adminUids.split(',')
                                             .map(uid => uid.trim())
                                             .filter(uid => uid.length > 0);
         } else if (!Array.isArray(updatedConfigData.adminUids)) {
             updatedConfigData.adminUids = []; // Garante que seja array
         }
        await db.collection('events').doc(this.currentEventId).set(updatedConfigData, { merge: true });
        console.log("Model: Config salva.");
        await this.loadEventConfig(this.currentEventId); // Recarrega
    },

    // --- Presentes (Agora por Event ID) ---
    async loadGifts() {
        console.log(`Model: Carregando presentes para evento ${this.currentEventId}...`);
        if (!this.currentEventId) { this.giftDataCache = []; return []; } // Retorna vazio se não há evento
        // Caminho alterado para subcoleção
        const snapshot = await db.collection('events').doc(this.currentEventId).collection('gifts').orderBy('name').get();
        this.giftDataCache = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        console.log("Model: Presentes carregados", this.giftDataCache); // Log do array carregado
        return this.giftDataCache;
    },

    async addGift(giftDetails) {
         console.log(`Model: Adicionando presente para evento ${this.currentEventId}...`, giftDetails);
         if (!this.isAdmin || !this.currentEventId) throw new Error("Acesso negado ou evento não carregado.");
         // Prepara o objeto a ser salvo, incluindo suggestedBrands
         const newGiftData = {
             name: giftDetails.name,
             description: giftDetails.description || '',
             quantity: giftDetails.quantity,
             img: giftDetails.img || '',
             suggestedBrands: giftDetails.suggestedBrands || '', // Adiciona o novo campo
             reserved: 0 // Sempre começa com 0
         };
         // Caminho alterado para subcoleção
         const docRef = await db.collection('events').doc(this.currentEventId).collection('gifts').add(newGiftData);
         console.log("Model: Presente adicionado", docRef.id);
         await this.loadGifts(); // Recarrega cache
         return docRef.id;
    },

    async deleteGift(giftId) {
        console.log(`Model: Deletando presente ${giftId} do evento ${this.currentEventId}...`);
        if (!this.isAdmin || !this.currentEventId) throw new Error("Acesso negado ou evento não carregado.");
        // Verifica se está reservado (lendo do cache)
        const giftInCache = this.giftDataCache.find(g => g.id === giftId);
        if (giftInCache && (giftInCache.reserved || 0) > 0) {
            throw new Error("Não é possível excluir um presente que já foi reservado.");
        }
         // Caminho alterado para subcoleção
        await db.collection('events').doc(this.currentEventId).collection('gifts').doc(giftId).delete();
        console.log("Model: Presente deletado.");
        await this.loadGifts(); // Recarrega cache
    },

    // --- RSVP (Agora por Event ID) ---
    async findRsvpByEmail(email) {
        console.log(`Model: Buscando RSVP por email ${email} no evento ${this.currentEventId}...`);
         if (!this.currentEventId) throw new Error("Evento não carregado.");
         // Adiciona try/catch pois regras podem bloquear leitura
         try {
             // Caminho alterado para subcoleção e query
            const snapshot = await db.collection('events').doc(this.currentEventId).collection('rsvps').where('email', '==', email).limit(1).get();
            if (!snapshot.empty) {
                const doc = snapshot.docs[0];
                this.currentRsvpData = { id: doc.id, ...doc.data() }; // Guarda dados localmente
                this.currentRsvpDocId = doc.id; // Guarda ID do documento
                console.log("Model: RSVP encontrado", this.currentRsvpData);
                return this.currentRsvpData;
            }
            console.log("Model: Nenhum RSVP encontrado.");
            this.currentRsvpData = null; // Limpa dados locais se não encontrou
            this.currentRsvpDocId = null;
            return null;
         } catch(error) {
              console.error("Model: Erro ao buscar RSVP por email (verifique regras de leitura para RSVPs):", error);
              // Não lança erro aqui, apenas retorna null para não quebrar o fluxo do blur (que foi removido do controller)
              this.currentRsvpData = null; this.currentRsvpDocId = null; return null;
         }
    },

    async saveRsvp(rsvpData) {
        console.log(`Model: Salvando RSVP para evento ${this.currentEventId}...`);
         if (!this.currentEventId) throw new Error("Evento não carregado.");
        rsvpData.timestamp = firebase.firestore.FieldValue.serverTimestamp();
        const rsvpCollectionRef = db.collection('events').doc(this.currentEventId).collection('rsvps'); // Ref da subcoleção
        if (this.currentRsvpDocId) { // Se já existe um ID (detectado pelo blur ou submit anterior), atualiza
            await rsvpCollectionRef.doc(this.currentRsvpDocId).update(rsvpData);
            console.log("Model: RSVP atualizado", this.currentRsvpDocId);
        } else { // Se não existe, cria um novo documento
            const docRef = await rsvpCollectionRef.add(rsvpData);
            this.currentRsvpDocId = docRef.id; // Guarda o ID do novo documento
            console.log("Model: RSVP criado", this.currentRsvpDocId);
        }
        // Atualiza o estado local com os dados salvos (incluindo o ID)
        this.currentRsvpData = { ...rsvpData, id: this.currentRsvpDocId };
        return true; // Sucesso
    },

    async reserveGiftTransaction(giftId, rsvpDocId, isDrawn) {
         console.log(`Model: Iniciando transação de reserva para evento ${this.currentEventId}...`);
         if (!this.currentEventId) throw new Error("Evento não carregado.");
         // Caminhos alterados para subcoleções
         const giftRef = db.collection('events').doc(this.currentEventId).collection('gifts').doc(giftId);
         const rsvpRef = db.collection('events').doc(this.currentEventId).collection('rsvps').doc(rsvpDocId);
         let giftName = '';

         await db.runTransaction(async (transaction) => {
            const giftDoc = await transaction.get(giftRef);
            if (!giftDoc.exists) throw new Error(`Presente ${giftId} não encontrado neste evento!`);
            const gift = giftDoc.data(); giftName = gift.name; const currentReserved = gift.reserved || 0;
            if (currentReserved >= gift.quantity) throw new Error(`"${giftName}" esgotado.`);
            transaction.update(giftRef, { reserved: currentReserved + 1 });
            transaction.update(rsvpRef, { giftId: giftId, giftName: giftName, drawn: isDrawn });
         });

         console.log("Model: Transação concluída.");
         // Atualiza cache local
         const cachedGift = this.giftDataCache.find(g => g.id === giftId);
         if (cachedGift) cachedGift.reserved = (cachedGift.reserved || 0) + 1;
         return giftName; // Retorna o nome para a View usar
    },

     // --- Autenticação ---
     async signInWithGoogle() {
         console.log("Model: Iniciando login com Google...");
         const result = await auth.signInWithPopup(googleProvider);
         console.log("Model: Login bem-sucedido", result.user?.uid);
         return result.user;
     },

     async signOut() {
         console.log("Model: Fazendo logout...");
         await auth.signOut();
         console.log("Model: Logout concluído.");
     },

     // --- Estado Interno ---
     setCurrentUser(user) {
         this.currentUser = user;
         this.checkAdminStatus(); // Verifica admin para o evento carregado
     },

     checkAdminStatus() {
         // Só pode ser admin se estiver logado E a config do evento atual foi carregada E o UID está na lista do evento
         if (this.currentUser && this.appConfig && this.appConfig.adminUids) {
             this.isAdmin = this.appConfig.adminUids.includes(this.currentUser.uid);
         } else {
             this.isAdmin = false;
         }
         console.log(`Model: Status Admin para evento ${this.currentEventId}: ${this.isAdmin}`);
     }
};

// --- VIEW ---
// Responsável por interagir com o DOM (ler e escrever no HTML)
const View = {
    // Referências a elementos DOM importantes
    elements: {
        loadingOverlay: document.getElementById('loading-overlay'),
        sections: document.querySelectorAll('.app-section'),
        eventErrorSection: document.getElementById('event-error-section'),
        eventErrorMessage: document.getElementById('event-error-message'),
        // Welcome
        welcomeImage: document.getElementById('welcome-image'),
        babyNameWelcome: document.getElementById('baby-name-welcome'),
        eventDate: document.getElementById('event-date'),
        eventTime: document.getElementById('event-time'),
        adminUidInfo: document.getElementById('admin-uid-info'),
        adminUidDisplay: document.getElementById('admin-uid-display'),
        eventIdInfo: document.getElementById('event-id-info'),
        eventIdDisplay: document.getElementById('event-id-display'),
        // RSVP
        rsvpForm: document.getElementById('rsvp-form'),
        guestNameInput: document.getElementById('guest-name'),
        guestEmailInput: document.getElementById('guest-email'),
        rsvpError: document.getElementById('rsvp-error'),
        // Gifts (Guest)
        giftListContainer: document.getElementById('gift-list-container'),
        giftListLoading: document.getElementById('gift-list-loading'),
        giftError: document.getElementById('gift-error'),
        giftSelectedInfo: document.getElementById('gift-selected-info'),
        confirmManualGiftBtn: document.getElementById('confirm-manual-gift-button'),
        // Location
        eventAddress: document.getElementById('event-address'),
        mapLink: document.getElementById('map-link'),
        // Calendar
        googleCalendarLink: document.getElementById('google-calendar-link'),
        // Thank You
        thankyouMessage: document.getElementById('thankyou-message'),
        // Admin
        adminSection: document.getElementById('admin-section'),
        adminWelcomeMsg: document.getElementById('admin-welcome-message'),
        adminUserName: document.getElementById('admin-user-name'),
        adminEventId: document.getElementById('admin-event-id'),
        adminEventForm: document.getElementById('admin-event-form'),
        adminBabyName: document.getElementById('admin-baby-name'),
        adminEventDate: document.getElementById('admin-event-date'),
        adminEventTime: document.getElementById('admin-event-time'),
        adminDuration: document.getElementById('admin-duration'),
        adminEventAddress: document.getElementById('admin-event-address'),
        adminUidsInput: document.getElementById('admin-uids'),
        adminGiftListDiv: document.getElementById('admin-gift-list'),
        adminGiftListLoading: document.getElementById('admin-gift-list-loading'),
        addGiftForm: document.getElementById('add-gift-form'),
        adminGiftError: document.getElementById('admin-gift-error'),
        adminGiftSuccess: document.getElementById('admin-gift-success'),
        // Nav
        mainNav: document.getElementById('main-nav'),
        navGiftButton: document.getElementById('nav-gift-button'),
        adminAuthButton: document.getElementById('admin-auth-button')
    },

    // --- Métodos de Atualização da UI ---
    showLoading() { this.elements.loadingOverlay?.classList.add('visible'); },
    hideLoading() { this.elements.loadingOverlay?.classList.remove('visible'); },

    showSection(sectionId) {
        this.elements.sections.forEach(section => section.classList.remove('active'));
        const activeSection = document.getElementById(sectionId);
        if (activeSection) activeSection.classList.add('active');
        else console.warn(`View: Seção com ID '${sectionId}' não encontrada.`);
        window.scrollTo(0, 0);
    },
     showEventLoadError(message) {
         if (this.elements.eventErrorMessage) this.elements.eventErrorMessage.textContent = message;
         this.showSection('event-error-section');
         this.hideLoading();
     },
    showError(element, message) { if(element) { element.textContent = message; element.classList.remove('hidden'); } else { console.error("View: Elemento de erro não encontrado:", element); } },
    hideError(element) { if(element) { element.classList.add('hidden'); element.textContent = ''; } },
    showSuccess(element, message) { if(element) { element.textContent = message; element.classList.remove('hidden'); setTimeout(() => this.hideError(element), 4000); } },

    applyTheme(themeColor = 'pink') {
        console.log("View: Aplicando tema:", themeColor);
        const root = document.documentElement;
        let p, s, a, t = '#333';
        switch (themeColor) { case 'blue': p = '#ADD8E6'; s = '#B0E0E6'; a = '#87CEFA'; t = '#00008B'; break; case 'green': p = '#98FB98'; s = '#90EE90'; a = '#3CB371'; t = '#006400'; break; case 'yellow': p = '#FFFFE0'; s = '#FFFACD'; a = '#FFD700'; t = '#8B4513'; break; case 'pink': default: p = '#FFC0CB'; s = '#FFB6C1'; a = '#FF69B4'; t = '#333'; break; }
        root.style.setProperty('--primary-color', p); root.style.setProperty('--secondary-color', s); root.style.setProperty('--accent-color', a); root.style.setProperty('--text-color', t);
        const spin = document.querySelector('.spinner'); if (spin) spin.style.borderLeftColor = p;
        const img = this.elements.welcomeImage; if (img && img.src.includes('placehold.co')) { try { const parts = img.src.split('/'); const size = parts[3]; const ct = parts[4].split('?'); const txt = ct[1] || ''; const bg = p.substring(1); const tcH = t.substring(1); const tc = tcH.length === 6 ? tcH : '333'; img.src = `https://placehold.co/${size}/${bg}/${tc}?${txt}`; } catch (e) { console.warn("View: Falha placeholder img."); } }
    },

    displayWelcomeInfo(config, eventId) {
        console.log("View: Recebido para UI -> ", config); // Log de diagnóstico
        if (!config) { console.log("View: displayWelcomeInfo chamado sem config."); return; }
        document.title = `Chá de Bebê da ${config.babyName || '[Nome]'}`;
        // Log específico para babyName
        console.log("View: Tentando exibir babyName:", config.babyName);
        if(this.elements.babyNameWelcome) {
            console.log("View: Elemento babyNameWelcome encontrado.");
            this.elements.babyNameWelcome.textContent = config.babyName || '...';
        } else {
            console.error("View: Elemento babyNameWelcome NÃO encontrado no HTML!");
        }

        if (config.eventDate instanceof Date && !isNaN(config.eventDate)) {
            if(this.elements.eventDate) this.elements.eventDate.textContent = config.eventDate.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric' });
            if(this.elements.eventTime) this.elements.eventTime.textContent = config.eventDate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        } else {
            console.log("View: eventDate inválido ou nulo ao exibir:", config.eventDate);
            if(this.elements.eventDate) this.elements.eventDate.textContent = "Inválida";
            if(this.elements.eventTime) this.elements.eventTime.textContent = "";
        }
        if(this.elements.eventIdDisplay) this.elements.eventIdDisplay.textContent = eventId || 'N/A';
    },

    displayEventDetails(config) {
        if (!config) return;
        const address = config.eventAddress || "";
        if (this.elements.eventAddress) this.elements.eventAddress.textContent = address || "Endereço não definido";

        // Gera link do Google Maps
        if (address && this.elements.mapLink) {
            const mapQuery = encodeURIComponent(address);
            // Usa URL de busca padrão do Google Maps
            this.elements.mapLink.href = `https://www.google.com/maps/search/?api=1&query=${mapQuery}`;
            this.elements.mapLink.target = '_blank'; // Abrir em nova aba
            this.elements.mapLink.classList.remove('hidden'); // Mostra o botão
        } else if (this.elements.mapLink) {
            this.elements.mapLink.href = '#';
            this.elements.mapLink.classList.add('hidden'); // Esconde se não houver endereço
        }

        // Gera link do Google Calendar
        if (config.eventDate instanceof Date && !isNaN(config.eventDate) && this.elements.googleCalendarLink) {
            const startTime = config.eventDate; const duration = config.durationHours || 3;
            const endTime = new Date(startTime.getTime() + duration * 60 * 60 * 1000);
            const formatGoogleDate = (d) => d.toISOString().replace(/-|:|\.\d{3}/g, '');
            const googleStartDate = formatGoogleDate(startTime); const googleEndDate = formatGoogleDate(endTime);
            const calendarText = encodeURIComponent(`Chá de Bebê da ${config.babyName}`);
            const calendarDetails = encodeURIComponent(`Venha celebrar conosco! Local: ${address}`);
            const calendarLocation = encodeURIComponent(address);
            const googleLink = `https://www.google.com/calendar/render?action=TEMPLATE&text=${calendarText}&dates=${googleStartDate}/${googleEndDate}&details=${calendarDetails}&location=${calendarLocation}`;
            this.elements.googleCalendarLink.href = googleLink; this.elements.googleCalendarLink.onclick = null;
        } else if (this.elements.googleCalendarLink) {
            this.elements.googleCalendarLink.href = '#'; this.elements.googleCalendarLink.onclick = (e) => { e.preventDefault(); alert("Data do evento inválida ou não definida."); };
        }
    },

    updateAdminAuthButton(isUserAdmin, user) {
         const icon = this.elements.adminAuthButton.querySelector('img');
         const text = this.elements.adminAuthButton.querySelector('span');
         if (isUserAdmin) { icon.src = 'https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/log-out.svg'; icon.alt = 'Sair Admin'; text.textContent = 'Sair'; this.elements.adminAuthButton.classList.remove('text-gray-600', 'hover:text-theme-primary'); this.elements.adminAuthButton.classList.add('text-red-500', 'hover:text-red-700'); this.elements.adminUidDisplay.textContent = user?.uid || 'N/A'; this.elements.adminUidInfo.classList.remove('hidden'); this.elements.adminUserName.textContent = user?.displayName || user?.email || 'Admin'; this.elements.adminWelcomeMsg.classList.remove('hidden'); }
         else { icon.src = 'https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/log-in.svg'; icon.alt = 'Login Admin'; text.textContent = 'Admin'; this.elements.adminAuthButton.classList.add('text-gray-600', 'hover:text-theme-primary'); this.elements.adminAuthButton.classList.remove('text-red-500', 'hover:text-red-700'); this.elements.adminUidInfo.classList.add('hidden'); this.elements.adminWelcomeMsg.classList.add('hidden'); }
    },
    updateNavGiftButton(enabled) { if (this.elements.navGiftButton) this.elements.navGiftButton.disabled = !enabled; },
    fillRsvpForm(rsvpData) { if (this.elements.guestNameInput) this.elements.guestNameInput.value = rsvpData.name; const radio = document.querySelector(`input[name="attending"][value="${rsvpData.attending}"]`); if (radio) radio.checked = true; },
    clearRsvpForm() { if (this.elements.rsvpForm) this.elements.rsvpForm.reset(); },
    displayRsvpSuccess(name) { if (this.elements.thankyouMessage) this.elements.thankyouMessage.textContent = `Obrigado, ${name}! Sua resposta foi registada.`; },
    displayRsvpNo(name) { if (this.elements.thankyouMessage) this.elements.thankyouMessage.textContent = `Obrigado, ${name}! Sentiremos sua falta.`; },
    renderGiftList(gifts, onSelectCallback) { this.elements.giftListContainer.innerHTML = ''; this.hideError(this.elements.giftError); this.elements.giftListLoading.classList.add('hidden'); let hasAvailableGifts = false; if (!gifts || gifts.length === 0) { this.elements.giftListContainer.innerHTML = '<p class="text-center text-gray-500 col-span-full">Nenhum presente disponível.</p>'; return; } gifts.forEach(gift => { const reserved = gift.reserved || 0; const available = gift.quantity - reserved; if (available > 0) { hasAvailableGifts = true; const itemDiv = document.createElement('div'); itemDiv.className = 'gift-item border border-gray-200 rounded-lg p-3 text-center cursor-pointer hover:shadow-md bg-white'; itemDiv.dataset.giftId = gift.id; itemDiv.innerHTML = ` <img src="${gift.img || 'https://placehold.co/100x100/cccccc/ffffff?text=Img'}" alt="${gift.name}" class="h-16 w-16 mx-auto mb-2 rounded object-cover" onerror="this.src='https://placehold.co/100x100/cccccc/ffffff?text=Img'"> <p class="font-semibold text-sm">${gift.name}</p> <p class="text-xs text-gray-500">${gift.description || ''}</p> <p class="text-xs text-blue-500 mt-1">Disponível: ${available}</p>`; itemDiv.addEventListener('click', () => onSelectCallback(gift.id, itemDiv)); this.elements.giftListContainer.appendChild(itemDiv); } }); if (!hasAvailableGifts) { this.elements.giftListContainer.innerHTML = '<p class="text-center text-gray-500 col-span-full">Todos presentes escolhidos.</p>'; } },
    selectGiftUI(element) { document.querySelectorAll('.gift-item.selected').forEach(el => el.classList.remove('selected', 'border-2', 'border-theme-accent')); element.classList.add('selected', 'border-2', 'border-theme-accent'); this.elements.confirmManualGiftBtn.classList.remove('hidden'); this.hideError(this.elements.giftError); this.hideError(this.elements.giftSelectedInfo); },
    clearGiftSelectionUI() { document.querySelectorAll('.gift-item.selected').forEach(el => el.classList.remove('selected', 'border-2', 'border-theme-accent')); this.elements.confirmManualGiftBtn.classList.add('hidden'); },
    displayGiftResult(message, isSuccess) { const element = isSuccess ? this.elements.giftSelectedInfo : this.elements.giftError; this.showError(element === this.elements.giftError ? this.elements.giftSelectedInfo : this.elements.giftError, ''); if (isSuccess) this.showSuccess(element, message); else this.showError(element, message); },
    populateAdminForm(config, eventId) { if (!config) return; if(this.elements.adminEventId) this.elements.adminEventId.textContent = eventId || 'N/A'; try { this.elements.adminBabyName.value = config.babyName || ''; if (config.eventDate instanceof Date && !isNaN(config.eventDate)) { const dateStr = config.eventDate.getFullYear() + '-' + ('0' + (config.eventDate.getMonth() + 1)).slice(-2) + '-' + ('0' + config.eventDate.getDate()).slice(-2); const timeStr = ('0' + config.eventDate.getHours()).slice(-2) + ':' + ('0' + config.eventDate.getMinutes()).slice(-2); this.elements.adminEventDate.value = dateStr; this.elements.adminEventTime.value = timeStr; } else { this.elements.adminEventDate.value = ''; this.elements.adminEventTime.value = ''; } this.elements.adminEventAddress.value = config.eventAddress || ''; this.elements.adminDuration.value = config.durationHours || 3; const themeRadio = document.querySelector(`input[name="theme"][value="${config.themeColor || 'pink'}"]`); if (themeRadio) themeRadio.checked = true; if (this.elements.adminUidsInput) this.elements.adminUidsInput.value = (config.adminUids || []).join(', '); } catch (e) { console.error("View: Erro ao popular form admin:", e); this.showError(this.elements.adminGiftError, "Erro ao carregar dados do formulário."); } },
    renderAdminGiftList(gifts, deleteCallback) { this.elements.adminGiftListDiv.innerHTML = ''; if(this.elements.adminGiftListLoading) this.elements.adminGiftListLoading.classList.add('hidden'); if (!gifts || gifts.length === 0) { this.elements.adminGiftListDiv.innerHTML = '<p class="text-gray-500">Nenhum presente cadastrado.</p>'; return; } gifts.forEach(gift => { const reserved = gift.reserved || 0; const div = document.createElement('div'); div.className = 'flex justify-between items-center flex-wrap'; div.innerHTML = ` <div class="mb-2 mr-2"> <p class="font-semibold">${gift.name} <span class="text-xs text-gray-400">(ID: ${gift.id})</span></p> <p class="text-sm text-gray-600">${gift.description || 'Sem descrição'}</p> <p class="text-sm text-gray-500">Marcas: ${gift.suggestedBrands || 'Nenhuma'}</p> <p class="text-sm">Qtd Total: ${gift.quantity} | Reservados: ${reserved}</p> ${gift.img ? `<a href="${gift.img}" target="_blank" class="text-xs text-blue-500 hover:underline">Ver Imagem</a>` : '<span class="text-xs text-gray-400">Sem Imagem</span>'} </div> <div class="flex-shrink-0"> <button data-action="delete-gift" data-gift-id="${gift.id}" data-reserved-count="${reserved}" class="delete-button text-xs" ${reserved > 0 ? 'disabled title="Não pode excluir presentes já reservados"' : ''}> Excluir </button> </div>`; this.elements.adminGiftListDiv.appendChild(div); }); },
    clearAddGiftForm() { if(this.elements.addGiftForm) this.elements.addGiftForm.reset(); }
};

// --- CONTROLLER ---
const Controller = {
    selectedGiftId: null,

    init() {
        console.log("Controller: Inicializando aplicação...");
        View.showLoading();
        this.setupEventListeners();
        const urlParams = new URLSearchParams(window.location.search);
        const eventId = urlParams.get('event');
        if(View.elements.eventIdDisplay) View.elements.eventIdDisplay.textContent = eventId || 'Nenhum';

        if (!eventId) {
            console.error("Controller: Event ID não encontrado na URL.");
            View.showEventLoadError("ID do evento não encontrado na URL. Verifique o link.");
            return;
        }

        Model.loadEventConfig(eventId)
            .then(config => {
                this.setupUIWithConfig(); // Chama a atualização da UI aqui
                this.setupAuthListener();
                return Model.loadGifts(); // Carrega presentes depois
            })
            .then(() => {
                console.log("Controller: Configuração e presentes carregados.");
                View.showSection('welcome-section'); // Mostra welcome após carregar
            })
            .catch(error => {
                console.error("Controller: Erro na inicialização:", error);
                View.showEventLoadError(`Erro ao carregar evento: ${error.message}`);
            })
            .finally(() => { View.hideLoading(); });
    },

    setupEventListeners() {
        console.log("Controller: Configurando listeners...");
        if (View.elements.mainNav) { View.elements.mainNav.addEventListener('click', (e) => this.handleActionClick(e)); console.log("Controller: Listener mainNav OK."); } else { console.error("Controller: Elemento mainNav não encontrado!"); }
        document.body.addEventListener('click', (e) => this.handleActionClick(e)); console.log("Controller: Listener body OK.");
        if (View.elements.rsvpForm) { View.elements.rsvpForm.addEventListener('submit', (e) => this.handleRsvpSubmit(e)); console.log("Controller: Listener rsvpForm OK."); } else { console.warn("Controller: Elemento rsvpForm não encontrado.")};
        if (View.elements.guestEmailInput) { View.elements.guestEmailInput.addEventListener('blur', (e) => this.handleRsvpEmailBlur(e)); console.log("Controller: Listener guestEmailInput OK."); } else { console.warn("Controller: Elemento guestEmailInput não encontrado.")};
        if (View.elements.adminEventForm) { View.elements.adminEventForm.addEventListener('submit', (e) => this.handleAdminSaveConfig(e)); console.log("Controller: Listener adminEventForm OK."); } else { console.warn("Controller: Elemento adminEventForm não encontrado.")};
        if (View.elements.addGiftForm) { View.elements.addGiftForm.addEventListener('submit', (e) => this.handleAdminAddGift(e)); console.log("Controller: Listener addGiftForm OK."); } else { console.warn("Controller: Elemento addGiftForm não encontrado.")};
        if (View.elements.adminGiftListDiv) { View.elements.adminGiftListDiv.addEventListener('click', (e) => { const button = e.target.closest('button[data-action="delete-gift"]'); if (button) { const giftId = button.dataset.giftId; const reservedCount = parseInt(button.dataset.reservedCount, 10); this.handleAdminDeleteGift(giftId, reservedCount); } }); console.log("Controller: Listener adminGiftListDiv OK."); } else { console.warn("Controller: Elemento adminGiftListDiv não encontrado.")};
        if (View.elements.giftListContainer) { View.elements.giftListContainer.addEventListener('click', (e) => { const giftItem = e.target.closest('.gift-item'); if (giftItem && giftItem.dataset.giftId) { this.handleGiftSelect(giftItem.dataset.giftId, giftItem); } }); console.log("Controller: Listener giftListContainer OK."); } else { console.warn("Controller: Elemento giftListContainer não encontrado.")};
    },

    handleActionClick(event) {
         const button = event.target.closest('[data-action]');
         if (!button) return;
         const action = button.dataset.action;
         console.log(`Controller: handleActionClick disparado para ação: ${action}`, event.target);
         if (!Model.appConfig && action !== 'admin-auth' && action !== 'show-welcome') { alert("Aguarde o carregamento."); return; }
         try { switch (action) { case 'show-welcome': View.showSection('welcome-section'); break; case 'show-rsvp': View.showSection('rsvp-section'); break; case 'show-gift': View.showSection('gift-section'); break; case 'show-location': View.showSection('location-section'); break; case 'show-calendar': View.showSection('calendar-section'); break; case 'admin-auth': this.handleAdminAuth(); break; case 'confirm-manual-gift': this.handleConfirmManualGift(); break; case 'draw-gift': this.handleDrawGift(); break; default: console.warn(`Controller: Ação desconhecida: ${action}`); } }
         catch (error) { console.error(`Controller: Erro ação '${action}':`, error); if (View.elements.rsvpError) View.showError(View.elements.rsvpError, `Erro inesperado.`); }
     },

    setupAuthListener() { auth.onAuthStateChanged(async (user) => { console.log("Controller: Auth state changed", user?.uid); Model.setCurrentUser(user); View.updateAdminAuthButton(Model.isAdmin, Model.currentUser); View.updateNavGiftButton(Model.appConfig && (Model.isAdmin || Model.currentRsvpData?.attending === 'yes')); if (!Model.isAdmin && View.elements.adminSection.classList.contains('active')) { View.showSection('welcome-section'); } if (Model.isAdmin && View.elements.adminSection.classList.contains('active')) { View.populateAdminForm(Model.appConfig, Model.currentEventId); View.renderAdminGiftList(Model.giftDataCache, this.handleAdminDeleteGift.bind(this)); } }); },

    async handleRsvpSubmit(event) {
        event.preventDefault(); View.hideError(View.elements.rsvpError);
        if (!Model.appConfig) { View.showError(View.elements.rsvpError, "Configuração carregando..."); return; }
        const name = View.elements.guestNameInput.value.trim(); const email = View.elements.guestEmailInput.value.trim(); const attendingRadio = document.querySelector('input[name="attending"]:checked');
        if (!name || !email || !attendingRadio || !/^\S+@\S+\.\S+$/.test(email)) { View.showError(View.elements.rsvpError, "Preencha corretamente."); return; }
        const attending = attendingRadio.value;
        View.showLoading();
        try {
            // Lógica para determinar se cria ou atualiza (baseado no estado do Model)
            if (Model.currentRsvpData?.email === email) { Model.currentRsvpDocId = Model.currentRsvpData.id; console.log("Ctrl: Email corresponde, update:", Model.currentRsvpDocId); }
            else { Model.currentRsvpDocId = null; Model.currentRsvpData = null; console.log("Ctrl: Email diferente, criar novo."); }
            const rsvp = { name, email, attending };
            if (attending === 'no') { rsvp.giftId = null; rsvp.giftName = null; rsvp.drawn = null; }
            else if (Model.currentRsvpDocId) { rsvp.giftId = Model.currentRsvpData.giftId || null; rsvp.giftName = Model.currentRsvpData.giftName || null; rsvp.drawn = Model.currentRsvpData.drawn ?? null; }
            await Model.saveRsvp(rsvp);
            if (attending === 'yes') { View.showSection('gift-section'); }
            else { View.displayRsvpNo(name); View.showSection('thankyou-section'); }
        } catch (error) { console.error("Controller: Erro RSVP submit", error); if (error.code === 'permission-denied') { View.showError(View.elements.rsvpError, `Erro permissão salvar.`); } else { View.showError(View.elements.rsvpError, `Erro salvar: ${error.message}`); } }
        finally { View.hideLoading(); }
    },
    async handleRsvpEmailBlur(event) { console.log("Controller: Email blur - verificação Firestore removida."); },
    handleGiftSelect(giftId, element) { console.log("Controller: Presente selecionado", giftId); this.selectedGiftId = giftId; View.selectGiftUI(element); },
    async handleConfirmManualGift() { View.hideError(View.elements.giftError); if (!Model.appConfig || !this.selectedGiftId || !Model.currentRsvpData || !Model.currentRsvpDocId || Model.currentRsvpData.attending !== 'yes') { View.showError(View.elements.giftError, "Confirme presença (Sim) e selecione."); if (!Model.currentRsvpData || Model.currentRsvpData.attending !== 'yes') View.showSection('rsvp-section'); return; } View.showLoading(); try { const giftName = await Model.reserveGiftTransaction(this.selectedGiftId, Model.currentRsvpDocId, false); View.displayRsvpSuccess(Model.currentRsvpData.name); View.showSection('thankyou-section'); this.selectedGiftId = null; View.clearGiftSelectionUI(); } catch (error) { console.error("Ctrl: Erro confirmar presente", error); View.displayGiftResult(error.message || "Erro reservar.", false); await Model.loadGifts(); View.renderGiftList(Model.giftDataCache, this.handleGiftSelect.bind(this)); } finally { View.hideLoading(); } },
    async handleDrawGift() { View.clearGiftSelectionUI(); View.hideError(View.elements.giftError); if (!Model.appConfig || !Model.currentRsvpData || !Model.currentRsvpDocId || Model.currentRsvpData.attending !== 'yes') { View.showError(View.elements.giftError, "Confirme presença (Sim)."); View.showSection('rsvp-section'); return; } View.showLoading(); try { const availableGifts = Model.giftDataCache.filter(g => (g.quantity - (g.reserved || 0)) > 0); if (availableGifts.length === 0) throw new Error("Todos presentes escolhidos."); const randomIndex = Math.floor(Math.random() * availableGifts.length); const drawnGift = availableGifts[randomIndex]; this.selectedGiftId = null; const giftName = await Model.reserveGiftTransaction(drawnGift.id, Model.currentRsvpDocId, true); View.displayGiftResult(`Presente sorteado: ${giftName}! Registando...`, true); View.renderGiftList(Model.giftDataCache, this.handleGiftSelect.bind(this)); setTimeout(() => { View.displayRsvpSuccess(Model.currentRsvpData.name); View.showSection('thankyou-section'); }, 2000); } catch (error) { console.error("Ctrl: Erro sortear presente", error); View.displayGiftResult(error.message || "Erro sortear.", false); } finally { View.hideLoading(); } },
    async handleAdminAuth() { if (Model.currentUser && Model.isAdmin) { View.showLoading(); try { await Model.signOut(); } catch (e) { console.error("Logout err", e); alert("Erro logout."); } finally { View.hideLoading(); } } else { View.showLoading(); try { await Model.signInWithGoogle(); } catch (e) { console.error("Login err", e); if(e.code !== 'auth/popup-closed-by-user' && e.code !== 'auth/cancelled-popup-request') { alert(`Erro login: ${e.message}`);} } finally { View.hideLoading(); } } },
    async handleAdminSaveConfig(event) { event.preventDefault(); if (!Model.isAdmin) { return; } View.showLoading(); View.hideError(View.elements.adminGiftError); View.hideError(View.elements.adminGiftSuccess); try { const babyName = View.elements.adminBabyName.value.trim(); const eventDateStr = View.elements.adminEventDate.value; const eventTimeStr = View.elements.adminEventTime.value; const eventAddress = View.elements.adminEventAddress.value.trim(); const durationHours = parseInt(View.elements.adminDuration.value, 10); const selectedTheme = document.querySelector('input[name="theme"]:checked')?.value || 'pink'; const adminUidsStr = View.elements.adminUidsInput.value.trim(); if (!babyName || !eventDateStr || !eventTimeStr || !eventAddress || isNaN(durationHours) || durationHours < 1) throw new Error("Preencha campos."); const eventDateTime = new Date(`${eventDateStr}T${eventTimeStr}:00`); if (isNaN(eventDateTime.getTime())) throw new Error("Data/hora inválida."); const checkDate = eventDateTime.getDate() == eventDateStr.split('-')[2]; const checkMonth = (eventDateTime.getMonth() + 1) == eventDateStr.split('-')[1]; if (!checkDate || !checkMonth) throw new Error("Data inválida (dia/mês)."); const adminUids = adminUidsStr.split(',').map(uid => uid.trim()).filter(uid => uid.length > 0); await Model.saveEventConfig({ babyName, eventDate: eventDateTime, eventAddress, durationHours, themeColor: selectedTheme, adminUids }); View.applyTheme(Model.appConfig.themeColor); this.setupUIWithConfig(); View.showSuccess(View.elements.adminGiftSuccess, "Detalhes salvos!"); } catch (error) { console.error("Ctrl: Erro save config", error); View.showError(View.elements.adminGiftError, `Erro: ${error.message}`); } finally { View.hideLoading(); } },
    async handleAdminAddGift(event) { event.preventDefault(); if (!Model.isAdmin) { return; } View.showLoading(); View.hideError(View.elements.adminGiftError); View.hideError(View.elements.adminGiftSuccess); try { const name = document.getElementById('new-gift-name').value.trim(); const description = document.getElementById('new-gift-desc').value.trim(); const quantity = parseInt(document.getElementById('new-gift-qty').value, 10); const img = document.getElementById('new-gift-img').value.trim(); const suggestedBrands = document.getElementById('new-gift-brands').value.trim(); if (!name || isNaN(quantity) || quantity < 1) throw new Error("Nome e quantidade (>=1) obrigatórios."); await Model.addGift({ name, description, quantity, img, suggestedBrands }); View.clearAddGiftForm(); View.showSuccess(View.elements.adminGiftSuccess, `Presente "${name}" adicionado!`); View.renderAdminGiftList(Model.giftDataCache, this.handleAdminDeleteGift.bind(this)); } catch (error) { console.error("Ctrl: Erro add gift", error); View.showError(View.elements.adminGiftError, `Erro: ${error.message}`); } finally { View.hideLoading(); } },
    async handleAdminDeleteGift(giftId, reservedCount) { if (!Model.isAdmin) { return; } if (reservedCount > 0) { alert("Não pode excluir presentes já reservados."); return; } if (!confirm(`Excluir presente ID: ${giftId}?`)) return; View.showLoading(); View.hideError(View.elements.adminGiftError); View.hideError(View.elements.adminGiftSuccess); try { await Model.deleteGift(giftId); View.showSuccess(View.elements.adminGiftSuccess, `Presente ${giftId} excluído!`); View.renderAdminGiftList(Model.giftDataCache, this.handleAdminDeleteGift.bind(this)); } catch (error) { console.error("Ctrl: Erro delete gift", error); View.showError(View.elements.adminGiftError, `Erro: ${error.message}`); } finally { View.hideLoading(); } },
    setupUIWithConfig() { View.displayWelcomeInfo(Model.appConfig, Model.currentEventId); View.displayEventDetails(Model.appConfig); if (Model.isAdmin) { View.populateAdminForm(Model.appConfig, Model.currentEventId); } }
};

// --- Inicialização ---
document.addEventListener('DOMContentLoaded', () => {
     console.log(">>> TESTE: SCRIPT PRINCIPAL INICIOU <<<"); // Mantém log inicial
     if (!firebaseConfig || !firebaseConfig.apiKey || firebaseConfig.apiKey === "SUA_API_KEY") { alert("Config Firebase incompleta!"); if(typeof View !== 'undefined' && View.showEventLoadError) { View.showEventLoadError("Config Firebase incompleta."); } else { document.body.innerHTML = '<p style="color:red; padding: 20px;">Erro crítico config Firebase.</p>'; } return; }
     Controller.init();
});
