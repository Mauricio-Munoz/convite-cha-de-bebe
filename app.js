// Importa a configuração do Firebase de um arquivo externo
import firebaseConfig from './firebase-config.js';

// --- Inicialização do Firebase ---
let db, auth, googleProvider;

/**
 * Inicializa o Firebase e suas dependências.
 */
try {
    // Inicializa o Firebase com a configuração fornecida
    const app = firebase.initializeApp(firebaseConfig);
    db = firebase.firestore(); // Inicializa o Firestore para acesso ao banco de dados
    auth = firebase.auth(); // Inicializa o módulo de autenticação
    googleProvider = new firebase.auth.GoogleAuthProvider(); // Configura autenticação via Google
    console.log("Firebase inicializado com sucesso.");
} catch (e) {
    // Se houver erro na inicialização do Firebase, exibe uma mensagem crítica
    console.error("Erro ao inicializar o Firebase:", e);
    alert("Erro na configuração do Firebase.");
    if (typeof View !== 'undefined' && View.showEventLoadError) {
        View.showEventLoadError('Erro ao inicializar o Firebase.');
        View.hideLoading();
    }
    return;
}

// --- MODEL ---
const Model = {
    currentEventId: null, // ID do evento atual
    appConfig: null, // Configurações do evento carregadas
    giftDataCache: [], // Cache dos dados de presentes
    currentUser: null, // Usuário logado no momento
    isAdmin: false, // Indica se o usuário é administrador
    currentRsvpData: null, // Dados da confirmação de presença
    currentRsvpDocId: null, // ID do documento da confirmação

    /**
     * Carrega a configuração do evento a partir do Firestore.
     * @param {string} eventId - ID do evento a ser carregado.
     */
    async loadEventConfig(eventId) {
        try {
            const eventDoc = await db.collection('events').doc(eventId).get();
            if (!eventDoc.exists) throw new Error("Evento não encontrado.");
            return eventDoc.data();
        } catch (error) {
            console.error("Erro ao carregar configuração do evento:", error);
            throw error;
        }
    },

    /**
     * Salva as configurações atualizadas do evento no Firestore.
     * @param {Object} updatedConfigData - Novas configurações do evento.
     */
    async saveEventConfig(updatedConfigData) {
        try {
            await db.collection('events').doc(this.currentEventId).update(updatedConfigData);
        } catch (error) {
            console.error("Erro ao salvar configuração do evento:", error);
            throw error;
        }
    },

    /**
     * Carrega a lista de presentes do Firestore.
     */
    async loadGifts() {
        try {
            const giftsSnapshot = await db.collection('events').doc(this.currentEventId).collection('gifts').get();
            this.giftDataCache = giftsSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            return this.giftDataCache;
        } catch (error) {
            console.error("Erro ao carregar presentes:", error);
            throw error;
        }
    },

    /**
     * Adiciona um novo presente ao Firestore.
     * @param {Object} giftDetails - Detalhes do presente a ser adicionado.
     */
    async addGift(giftDetails) {
        try {
            await db.collection('events').doc(this.currentEventId).collection('gifts').add(giftDetails);
        } catch (error) {
            console.error("Erro ao adicionar presente:", error);
            throw error;
        }
    },

    /**
     * Remove um presente do Firestore.
     * @param {string} giftId - ID do presente a ser removido.
     */
    async deleteGift(giftId) {
        try {
            await db.collection('events').doc(this.currentEventId).collection('gifts').doc(giftId).delete();
        } catch (error) {
            console.error("Erro ao deletar presente:", error);
            throw error;
        }
    },

    /**
     * Procura uma confirmação de presença pelo email no Firestore.
     * @param {string} email - Email do convidado.
     */
    async findRsvpByEmail(email) {
        try {
            const rsvpSnapshot = await db.collection('events').doc(this.currentEventId).collection('rsvps').where('email', '==', email).limit(1).get();
            if (rsvpSnapshot.empty) return null;
            const rsvpDoc = rsvpSnapshot.docs[0];
            return { id: rsvpDoc.id, ...rsvpDoc.data() };
        } catch (error) {
            console.error("Erro ao buscar RSVP por email:", error);
            throw error;
        }
    },

    /**
     * Salva ou atualiza uma confirmação de presença no Firestore.
     * @param {Object} rsvpData - Dados da confirmação de presença.
     */
    async saveRsvp(rsvpData) {
        try {
            const rsvpRef = db.collection('events').doc(this.currentEventId).collection('rsvps').doc(this.currentRsvpDocId || undefined);
            if (this.currentRsvpDocId) {
                await rsvpRef.update(rsvpData); // Atualiza se já existir
            } else {
                await rsvpRef.set(rsvpData); // Cria novo se não existir
            }
        } catch (error) {
            console.error("Erro ao salvar RSVP:", error);
            throw error;
        }
    },

    /**
     * Reserva um presente no Firestore.
     * @param {string} giftId - ID do presente a ser reservado.
     * @param {string} rsvpDocId - ID do documento da confirmação.
     * @param {boolean} isDrawn - Indica se o presente foi sorteado.
     */
    async reserveGiftTransaction(giftId, rsvpDocId, isDrawn) {
        try {
            const giftRef = db.collection('events').doc(this.currentEventId).collection('gifts').doc(giftId);
            const rsvpRef = db.collection('events').doc(this.currentEventId).collection('rsvps').doc(rsvpDocId);

            // Atualiza o presente e o RSVP em uma transação atômica
            await db.runTransaction(async (transaction) => {
                const giftDoc = await transaction.get(giftRef);
                const rsvpDoc = await transaction.get(rsvpRef);

                if (!giftDoc.exists || !rsvpDoc.exists) throw new Error("Documento inexistente.");

                const giftData = giftDoc.data();
                const rsvpData = rsvpDoc.data();

                if (giftData.reserved) throw new Error("Presente já reservado.");
                if (rsvpData.gift && rsvpData.gift.id) throw new Error("Convidado já escolheu um presente.");

                transaction.update(giftRef, { reserved: true, reservedBy: rsvpDoc.id });
                transaction.update(rsvpRef, { gift: { id: giftId, isDrawn } });
            });
        } catch (error) {
            console.error("Erro ao reservar presente:", error);
            throw error;
        }
    },

    /**
     * Autentica o usuário usando o Google.
     */
    async signInWithGoogle() {
        try {
            const result = await auth.signInWithPopup(googleProvider);
            this.setCurrentUser(result.user);
        } catch (error) {
            console.error("Erro ao autenticar com Google:", error);
            throw error;
        }
    },

    /**
     * Desconecta o usuário atual.
     */
    async signOut() {
        try {
            await auth.signOut();
            this.setCurrentUser(null);
        } catch (error) {
            console.error("Erro ao desconectar usuário:", error);
            throw error;
        }
    },

    /**
     * Define o usuário atual no modelo.
     * @param {Object|null} user - Objeto do usuário ou null se desconectado.
     */
    setCurrentUser(user) {
        this.currentUser = user;
        this.checkAdminStatus();
    },

    /**
     * Verifica se o usuário atual é administrador.
     */
    checkAdminStatus() {
        if (this.currentUser && this.appConfig.adminUIDs.includes(this.currentUser.uid)) {
            this.isAdmin = true;
        } else {
            this.isAdmin = false;
        }
    }
};

// --- VIEW ---
const View = {
    elements: {
        sections: {
            welcome: document.getElementById('welcome-section'),
            rsvp: document.getElementById('rsvp-section'),
            gift: document.getElementById('gift-section'),
            location: document.getElementById('location-section'),
            calendar: document.getElementById('calendar-section'),
            thankyou: document.getElementById('thankyou-section'),
            admin: document.getElementById('admin-section'),
            error: document.getElementById('event-error-section')
        },
        loadingOverlay: document.getElementById('loading-overlay'),
        navButtons: document.querySelectorAll('#main-nav button[data-action]'),
        adminAuthButton: document.getElementById('admin-auth-button'),
        navGiftButton: document.getElementById('nav-gift-button')
    },

    /**
     * Exibe o overlay de carregamento.
     */
    showLoading() {
        this.elements.loadingOverlay.classList.add('visible');
    },

    /**
     * Esconde o overlay de carregamento.
     */
    hideLoading() {
        this.elements.loadingOverlay.classList.remove('visible');
    },

    /**
     * Exibe uma seção específica.
     * @param {string} sectionId - ID da seção a ser exibida.
     */
    showSection(sectionId) {
        for (const section of Object.values(this.elements.sections)) {
            section.classList.remove('active');
        }
        this.elements.sections[sectionId].classList.add('active');
    },

    /**
     * Exibe uma mensagem de erro relacionada ao evento.
     * @param {string} message - Mensagem de erro.
     */
    showEventLoadError(message) {
        this.elements.sections.error.classList.add('active');
        document.getElementById('event-error-message').textContent = message;
    },

    /**
     * Exibe uma mensagem de erro em um elemento específico.
     * @param {HTMLElement} element - Elemento onde a mensagem será exibida.
     * @param {string} message - Mensagem de erro.
     */
    showError(element, message) {
        element.textContent = message;
        element.classList.remove('hidden');
        element.classList.add('text-red-500');
    },

    /**
     * Esconde uma mensagem de erro em um elemento específico.
     * @param {HTMLElement} element - Elemento onde a mensagem será escondida.
     */
    hideError(element) {
        element.textContent = '';
        element.classList.add('hidden');
        element.classList.remove('text-red-500');
    },

    /**
     * Exibe uma mensagem de sucesso em um elemento específico.
     * @param {HTMLElement} element - Elemento onde a mensagem será exibida.
     * @param {string} message - Mensagem de sucesso.
     */
    showSuccess(element, message) {
        element.textContent = message;
        element.classList.remove('hidden');
        element.classList.add('text-green-600');
    },

    /**
     * Aplica o tema de cor ao aplicativo.
     * @param {string} themeColor - Cor do tema (pink, blue, green, yellow).
     */
    applyTheme(themeColor = 'pink') {
        document.documentElement.style.setProperty('--theme-primary', `var(--${themeColor}-primary)`);
        document.documentElement.style.setProperty('--theme-secondary', `var(--${themeColor}-secondary)`);
        document.documentElement.style.setProperty('--theme-accent', `var(--${themeColor}-accent)`);
    },

    /**
     * Exibe informações de boas-vindas na tela inicial.
     * @param {Object} config - Configurações do evento.
     * @param {string} eventId - ID do evento.
     */
    displayWelcomeInfo(config, eventId) {
        document.getElementById('baby-name-welcome').textContent = config.babyName || 'Bebê';
        document.getElementById('event-date').textContent = config.eventDateFormatted || 'A definir';
        document.getElementById('event-time').textContent = config.eventTimeFormatted || 'A definir';
        document.getElementById('event-id-display').textContent = eventId;
    },

    /**
     * Exibe os detalhes do local do evento.
     * @param {Object} config - Configurações do evento.
     */
    displayEventDetails(config) {
        document.getElementById('event-address').textContent = config.address || 'Endereço indisponível';
        const mapLink = document.getElementById('map-link');
        if (config.address) {
            mapLink.href = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(config.address)}`;
            mapLink.classList.remove('hidden');
        } else {
            mapLink.classList.add('hidden');
        }
    },

    /**
     * Atualiza o botão de autenticação de administrador.
     * @param {boolean} isUserAdmin - Indica se o usuário é administrador.
     * @param {Object|null} user - Objeto do usuário ou null.
     */
    updateAdminAuthButton(isUserAdmin, user) {
        const adminAuthButton = this.elements.adminAuthButton;
        if (isUserAdmin) {
            adminAuthButton.querySelector('img').src = "https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/log-out.svg";
            adminAuthButton.querySelector('span').textContent = "Sair Admin";
            adminAuthButton.setAttribute('data-action', 'sign-out');
        } else {
            adminAuthButton.querySelector('img').src = "https://cdn.jsdelivr.net/npm/lucide-static@latest/icons/log-in.svg";
            adminAuthButton.querySelector('span').textContent = "Admin";
            adminAuthButton.setAttribute('data-action', 'admin-auth');
        }
    },

    /**
     * Ativa ou desativa o botão de presentes na navegação.
     * @param {boolean} enabled - Indica se o botão deve ser ativado.
     */
    updateNavGiftButton(enabled) {
        this.elements.navGiftButton.disabled = !enabled;
        this.elements.navGiftButton.classList.toggle('disabled:opacity-50', !enabled);
    },

    /**
     * Preenche o formulário de confirmação de presença com os dados do usuário.
     * @param {Object} rsvpData - Dados da confirmação de presença.
     */
    fillRsvpForm(rsvpData) {
        document.getElementById('guest-name').value = rsvpData.name || '';
        document.getElementById('guest-email').value = rsvpData.email || '';
        const attendingRadio = document.querySelector(`input[name="attending"][value="${rsvpData.attending ? 'yes' : 'no'}"]`);
        if (attendingRadio) attendingRadio.checked = true;
    },

    /**
     * Limpa o formulário de confirmação de presença.
     */
    clearRsvpForm() {
        document.getElementById('rsvp-form').reset();
        this.hideError(document.getElementById('rsvp-error'));
    },

    /**
     * Exibe uma mensagem de sucesso para confirmação de presença.
     * @param {string} name - Nome do convidado.
     */
    displayRsvpSuccess(name) {
        this.elements.sections.thankyou.classList.add('active');
        document.getElementById('thankyou-message').textContent = `Obrigado, ${name}! Sua resposta foi registrada.`;
    },

    /**
     * Exibe uma mensagem para quem não poderá comparecer.
     * @param {string} name - Nome do convidado.
     */
    displayRsvpNo(name) {
        this.elements.sections.thankyou.classList.add('active');
        document.getElementById('thankyou-message').textContent = `${name}, esperamos que você possa participar em outra ocasião.`;
    },

    /**
     * Renderiza a lista de presentes.
     * @param {Array} gifts - Lista de presentes.
     * @param {Function} onSelectCallback - Função chamada ao selecionar um presente.
     */
    renderGiftList(gifts, onSelectCallback) {
        const container = document.getElementById('gift-list-container');
        container.innerHTML = '';
        if (gifts.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-500 col-span-full">Nenhum presente disponível.</p>';
            return;
        }

        gifts.forEach((gift) => {
            const card = document.createElement('div');
            card.className = `relative bg-white rounded-lg shadow-md p-4 cursor-pointer hover:bg-gray-50 transition-colors ${
                gift.reserved ? 'opacity-50 cursor-not-allowed' : ''
            }`;
            card.innerHTML = `
                <img src="${gift.imageUrl || 'https://placehold.co/100x100/cccccc/ffffff?text=Sem+Imagem'}" alt="Presente" class="w-full h-24 object-cover mb-2">
                <h3 class="font-bold text-sm">${gift.name}</h3>
                <p class="text-xs text-gray-500">${gift.description || ''}</p>
                <p class="text-xs mt-1">${gift.quantity > 0 ? `${gift.quantity} disponíveis` : 'Esgotado'}</p>
                ${
                    gift.reserved
                        ? '<p class="absolute top-2 right-2 bg-yellow-100 text-yellow-800 text-xs px-2 py-1 rounded-full">Reservado</p>'
                        : ''
                }
            `;
            if (!gift.reserved) {
                card.addEventListener('click', () => onSelectCallback(gift.id, card));
            }
            container.appendChild(card);
        });
    },

    /**
     * Seleciona visualmente um presente na interface.
     * @param {HTMLElement} element - Elemento do presente selecionado.
     */
    selectGiftUI(element) {
        const selectedGift = document.querySelector('.selected-gift');
        if (selectedGift) {
            selectedGift.classList.remove('border-theme-accent', 'border-2');
        }
        element.classList.add('border-theme-accent', 'border-2');
    },

    /**
     * Limpa a seleção visual de presentes.
     */
    clearGiftSelectionUI() {
        const selectedGift = document.querySelector('.selected-gift');
        if (selectedGift) {
            selectedGift.classList.remove('border-theme-accent', 'border-2');
        }
    },

    /**
     * Exibe o resultado da reserva de presente.
     * @param {string} message - Mensagem de resultado.
     * @param {boolean} isSuccess - Indica se a operação foi bem-sucedida.
     */
    displayGiftResult(message, isSuccess) {
        const resultElement = document.getElementById('gift-selected-info');
        resultElement.textContent = message;
        resultElement.classList.remove('hidden');
        resultElement.classList.toggle('text-green-600', isSuccess);
        resultElement.classList.toggle('text-red-500', !isSuccess);
    },

    /**
     * Preenche o formulário de administração com os dados do evento.
     * @param {Object} config - Configurações do evento.
     * @param {string} eventId - ID do evento.
     */
    populateAdminForm(config, eventId) {
        document.getElementById('admin-baby-name').value = config.babyName || '';
        document.getElementById('admin-event-date').value = config.eventDate || '';
        document.getElementById('admin-event-time').value = config.eventTime || '';
        document.getElementById('admin-duration').value = config.duration || 3;
        document.getElementById('admin-event-address').value = config.address || '';
        document.getElementById('admin-uids').value = config.adminUIDs.join(',') || '';
        document.querySelector(`input[name="theme"][value="${config.theme || 'pink'}"]`).checked = true;
        document.getElementById('admin-event-id').textContent = eventId;
    },

    /**
     * Renderiza a lista de presentes no painel de administração.
     * @param {Array} gifts - Lista de presentes.
     * @param {Function} deleteCallback - Função chamada ao deletar um presente.
     */
    renderAdminGiftList(gifts, deleteCallback) {
        const container = document.getElementById('admin-gift-list');
        container.innerHTML = '';
        if (gifts.length === 0) {
            container.innerHTML = '<p class="text-center text-gray-500">Nenhum presente cadastrado.</p>';
            return;
        }

        gifts.forEach((gift) => {
            const card = document.createElement('div');
            card.className = 'bg-white rounded-lg shadow-md p-4 mb-4 relative';
            card.innerHTML = `
                <div class="flex justify-between items-center">
                    <div>
                        <h3 class="font-bold text-sm">${gift.name}</h3>
                        <p class="text-xs text-gray-500">${gift.description || ''}</p>
                        <p class="text-xs mt-1">${gift.quantity > 0 ? `${gift.quantity} disponíveis` : 'Esgotado'}</p>
                        <p class="text-xs mt-1">${gift.suggestedBrands ? `Marcas sugeridas: ${gift.suggestedBrands}` : ''}</p>
                    </div>
                    <button data-action="delete-gift" data-gift-id="${gift.id}" class="text-red-500 hover:text-red-700">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>
                ${
                    gift.reserved
                        ? '<p class="absolute top-2 right-2 bg-yellow-100 text-yellow-800 text-xs px-2 py-1 rounded-full">Reservado</p>'
                        : ''
                }
            `;
            const deleteButton = card.querySelector('[data-action="delete-gift"]');
            deleteButton.addEventListener('click', () => deleteCallback(gift.id, gift.reservedCount));
            container.appendChild(card);
        });
    },

    /**
     * Limpa o formulário de adição de presente.
     */
    clearAddGiftForm() {
        document.getElementById('add-gift-form').reset();
        this.hideError(document.getElementById('admin-gift-error'));
        this.hideSuccess(document.getElementById('admin-gift-success'));
    }
};

// --- CONTROLLER ---
const Controller = {
    selectedGiftId: null,

    /**
     * Inicializa o controlador e configura os listeners.
     */
    init() {
        console.log("Inicializando controlador...");
        this.setupEventListeners();
        this.setupAuthListener();

        // Obtém o ID do evento da URL
        const urlParams = new URLSearchParams(window.location.search);
        const eventId = urlParams.get('event');
        if (!eventId) {
            View.showEventLoadError("ID do evento ausente na URL.");
            return;
        }

        // Carrega a configuração do evento
        Model.loadEventConfig(eventId)
            .then((config) => {
                Model.currentEventId = eventId;
                Model.appConfig = config;
                View.applyTheme(config.theme);
                View.displayWelcomeInfo(config, eventId);
                View.displayEventDetails(config);
                View.hideLoading();
                this.setupUIWithConfig(config);
            })
            .catch((error) => {
                View.hideLoading();
                View.showEventLoadError("Falha ao carregar o evento.");
                console.error("Erro ao carregar evento:", error);
            });
    },

    /**
     * Configura os listeners de eventos.
     */
    setupEventListeners() {
        // Listener para cliques nos botões de navegação
        View.elements.navButtons.forEach((button) => {
            button.addEventListener('click', (event) => {
                const action = event.currentTarget.getAttribute('data-action');
                this.handleActionClick(action);
            });
        });

        // Listener para envio do formulário de RSVP
        document.getElementById('rsvp-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.handleRsvpSubmit(event);
        });

        // Listener para foco fora do campo de email do RSVP
        document.getElementById('guest-email').addEventListener('blur', (event) => {
            this.handleRsvpEmailBlur(event);
        });

        // Listener para sorteio de presente
        document.querySelector('[data-action="draw-gift"]').addEventListener('click', () => {
            this.handleDrawGift();
        });

        // Listener para confirmação manual de presente
        document.getElementById('confirm-manual-gift-button').addEventListener('click', () => {
            this.handleConfirmManualGift();
        });

        // Listener para autenticação de admin
        document.getElementById('admin-auth-button').addEventListener('click', () => {
            this.handleAdminAuth();
        });

        // Listener para salvamento de configurações de admin
        document.getElementById('admin-event-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.handleAdminSaveConfig(event);
        });

        // Listener para adição de presente no painel de admin
        document.getElementById('add-gift-form').addEventListener('submit', (event) => {
            event.preventDefault();
            this.handleAdminAddGift(event);
        });
    },

    /**
     * Configura o listener de autenticação do Firebase.
     */
    setupAuthListener() {
        auth.onAuthStateChanged((user) => {
            Model.setCurrentUser(user);
            View.updateAdminAuthButton(Model.isAdmin, user);
        });
    },

    /**
     * Manipula cliques nos botões de navegação.
     * @param {string} action - Ação a ser executada.
     */
    handleActionClick(action) {
        switch (action) {
            case 'show-welcome':
                View.showSection('welcome');
                break;
            case 'show-rsvp':
                View.showSection('rsvp');
                break;
            case 'show-gift':
                View.showSection('gift');
                break;
            case 'show-location':
                View.showSection('location');
                break;
            case 'show-calendar':
                View.showSection('calendar');
                break;
            case 'admin-auth':
                this.handleAdminAuth();
                break;
            case 'sign-out':
                this.handleSignOut();
                break;
            default:
                console.warn(`Ação desconhecida: ${action}`);
        }
    },

    /**
     * Manipula o envio do formulário de RSVP.
     * @param {Event} event - Evento de envio do formulário.
     */
    async handleRsvpSubmit(event) {
        const form = event.target;
        const name = form['guest-name'].value.trim();
        const email = form['guest-email'].value.trim();
        const attending = form['attending'].value === 'yes';

        if (!name || !email) {
            View.showError(document.getElementById('rsvp-error'), 'Por favor, preencha todos os campos.');
            return;
        }

        View.showLoading();
        try {
            let rsvpData = await Model.findRsvpByEmail(email);
            if (!rsvpData) {
                rsvpData = { name, email, attending, gift: null };
                await Model.saveRsvp(rsvpData);
            } else {
                rsvpData.name = name;
                rsvpData.attending = attending;
                await Model.saveRsvp(rsvpData);
            }

            if (attending) {
                View.displayRsvpSuccess(name);
            } else {
                View.displayRsvpNo(name);
            }
        } catch (error) {
            View.showError(document.getElementById('rsvp-error'), 'Erro ao salvar sua resposta.');
            console.error("Erro ao processar RSVP:", error);
        } finally {
            View.hideLoading();
        }
    },

    /**
     * Manipula o foco fora do campo de email do RSVP.
     * @param {Event} event - Evento de blur.
     */
    async handleRsvpEmailBlur(event) {
        const email = event.target.value.trim();
        if (!email) return;

        try {
            const rsvpData = await Model.findRsvpByEmail(email);
            if (rsvpData) {
                View.fillRsvpForm(rsvpData);
            }
        } catch (error) {
            console.error("Erro ao buscar RSVP por email:", error);
        }
    },

    /**
     * Manipula a seleção de um presente.
     * @param {string} giftId - ID do presente selecionado.
     * @param {HTMLElement} element - Elemento do presente selecionado.
     */
    handleGiftSelect(giftId, element) {
        if (this.selectedGiftId === giftId) {
            this.selectedGiftId = null;
            View.clearGiftSelectionUI();
        } else {
            this.selectedGiftId = giftId;
            View.selectGiftUI(element);
        }
    },

    /**
     * Manipula a confirmação manual de um presente.
     */
    async handleConfirmManualGift() {
        if (!this.selectedGiftId) {
            View.displayGiftResult('Selecione um presente antes de confirmar.', false);
            return;
        }

        View.showLoading();
        try {
            const rsvpDocId = Model.currentRsvpDocId || (await Model.findRsvpByEmail(document.getElementById('guest-email').value.trim())).id;
            await Model.reserveGiftTransaction(this.selectedGiftId, rsvpDocId, false);
            View.displayGiftResult('Presente reservado com sucesso!', true);
            View.clearGiftSelectionUI();
            this.selectedGiftId = null;
        } catch (error) {
            View.displayGiftResult('Erro ao reservar presente.', false);
            console.error("Erro ao reservar presente:", error);
        } finally {
            View.hideLoading();
        }
    },

    /**
     * Manipula o sorteio de um presente.
     */
    async handleDrawGift() {
        View.showLoading();
        try {
            const gifts = await Model.loadGifts();
            const availableGifts = gifts.filter((gift) => !gift.reserved && gift.quantity > 0);
            if (availableGifts.length === 0) {
                View.displayGiftResult('Não há presentes disponíveis para sorteio.', false);
                return;
            }

            const randomIndex = Math.floor(Math.random() * availableGifts.length);
            const selectedGift = availableGifts[randomIndex];
            const rsvpDocId = Model.currentRsvpDocId || (await Model.findRsvpByEmail(document.getElementById('guest-email').value.trim())).id;
            await Model.reserveGiftTransaction(selectedGift.id, rsvpDocId, true);
            View.displayGiftResult(`Você ganhou: ${selectedGift.name}!`, true);
        } catch (error) {
            View.displayGiftResult('Erro ao sortear presente.', false);
            console.error("Erro ao sortear presente:", error);
        } finally {
            View.hideLoading();
        }
    },

    /**
     * Manipula a autenticação de administrador.
     */
    async handleAdminAuth() {
        if (Model.isAdmin) {
            await Model.signOut();
        } else {
            await Model.signInWithGoogle();
        }
    },

    /**
     * Manipula o salvamento das configurações de admin.
     * @param {Event} event - Evento de envio do formulário.
     */
    async handleAdminSaveConfig(event) {
        const form = event.target;
        const babyName = form['admin-baby-name'].value.trim();
        const eventDate = form['admin-event-date'].value;
        const eventTime = form['admin-event-time'].value;
        const duration = parseInt(form['admin-duration'].value, 10);
        const address = form['admin-event-address'].value.trim();
        const adminUIDs = form['admin-uids'].value.split(',').map((uid) => uid.trim());
        const theme = form['theme'].value;

        if (!babyName || !eventDate || !eventTime || !address || isNaN(duration) || duration <= 0) {
            View.showError(document.getElementById('admin-gift-error'), 'Preencha todos os campos corretamente.');
            return;
        }

        View.showLoading();
        try {
            const updatedConfig = {
                babyName,
                eventDate,
                eventTime,
                duration,
                address,
                adminUIDs,
                theme
            };
            await Model.saveEventConfig(updatedConfig);
            View.showSuccess(document.getElementById('admin-gift-success'), 'Configurações salvas com sucesso!');
        } catch (error) {
            View.showError(document.getElementById('admin-gift-error'), 'Erro ao salvar configurações.');
            console.error("Erro ao salvar configurações:", error);
        } finally {
            View.hideLoading();
        }
    },

    /**
     * Manipula a adição de um presente no painel de admin.
     * @param {Event} event - Evento de envio do formulário.
     */
    async handleAdminAddGift(event) {
        const form = event.target;
        const name = form['new-gift-name'].value.trim();
        const description = form['new-gift-desc'].value.trim();
        const quantity = parseInt(form['new-gift-qty'].value, 10);
        const imageUrl = form['new-gift-img'].value.trim();
        const suggestedBrands = form['new-gift-brands'].value.trim();

        if (!name || isNaN(quantity) || quantity <= 0) {
            View.showError(document.getElementById('admin-gift-error'), 'Preencha todos os campos obrigatórios.');
            return;
        }

        View.showLoading();
        try {
            const giftDetails = {
                name,
                description,
                quantity,
                imageUrl,
                suggestedBrands,
                reserved: false,
                reservedBy: null
            };
            await Model.addGift(giftDetails);
            View.showSuccess(document.getElementById('admin-gift-success'), 'Presente adicionado com sucesso!');
            View.clearAddGiftForm();
        } catch (error) {
            View.showError(document.getElementById('admin-gift-error'), 'Erro ao adicionar presente.');
            console.error("Erro ao adicionar presente:", error);
        } finally {
            View.hideLoading();
        }
    },

    /**
     * Manipula a exclusão de um presente no painel de admin.
     * @param {string} giftId - ID do presente a ser excluído.
     * @param {number} reservedCount - Número de reservas do presente.
     */
    async handleAdminDeleteGift(giftId, reservedCount) {
        if (reservedCount > 0) {
            View.showError(document.getElementById('admin-gift-error'), 'Não é possível excluir um presente reservado.');
            return;
        }

        View.showLoading();
        try {
            await Model.deleteGift(giftId);
            View.showSuccess(document.getElementById('admin-gift-success'), 'Presente excluído com sucesso!');
        } catch (error) {
            View.showError(document.getElementById('admin-gift-error'), 'Erro ao excluir presente.');
            console.error("Erro ao excluir presente:", error);
        } finally {
            View.hideLoading();
        }
    },

    /**
     * Configura a interface com base nas configurações do evento.
     * @param {Object} config - Configurações do evento.
     */
    setupUIWithConfig(config) {
        // Atualiza o botão de presentes na navegação
        View.updateNavGiftButton(config.giftEnabled);

        // Atualiza o botão de administração
        View.updateAdminAuthButton(Model.isAdmin, Model.currentUser);
    }
};

// --- Inicialização ---
document.addEventListener('DOMContentLoaded', () => {
    console.log(">>> TESTE: SCRIPT PRINCIPAL INICIOU <<<");
    Controller.init();
});
