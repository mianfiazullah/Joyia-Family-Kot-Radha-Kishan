/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { 
  signInWithPopup, 
  onAuthStateChanged, 
  signOut, 
  User 
} from 'firebase/auth';
import { 
  collection, 
  addDoc, 
  onSnapshot, 
  query, 
  where, 
  doc, 
  setDoc, 
  getDoc,
  deleteDoc,
  updateDoc,
  serverTimestamp,
  getDocFromServer,
  writeBatch
} from 'firebase/firestore';
import { auth, db, googleProvider } from './firebase';
import { Family, Member, UserProfile } from './types';
import { 
  Plus, 
  Users, 
  LogOut, 
  LogIn, 
  Download, 
  Edit2, 
  Trash2, 
  ChevronRight, 
  ChevronDown, 
  User as UserIcon,
  Info,
  Share2,
  TreePine,
  Search
} from 'lucide-react';
import { motion, AnimatePresence, Reorder } from 'motion/react';
import * as d3 from 'd3';
import { jsPDF } from 'jspdf';
import html2canvas from 'html2canvas';
import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

// --- Components ---

const LoadingSpinner = () => (
  <div className="flex flex-col items-center justify-center h-screen bg-heritage-paper">
    <div className="relative">
      <motion.div
        animate={{ rotate: 360 }}
        transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
        className="w-24 h-24 border-2 border-heritage-gold/20 border-t-heritage-gold rounded-full"
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <TreePine className="w-8 h-8 text-heritage-gold animate-pulse" />
      </div>
    </div>
    <p className="mt-8 text-[10px] font-bold uppercase tracking-[0.4em] text-heritage-gold animate-pulse">Heritage Archive</p>
  </div>
);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [userProfile, setUserProfile] = useState<UserProfile | null>(null);
  const [families, setFamilies] = useState<Family[]>([]);
  const [activeFamily, setActiveFamily] = useState<Family | null>(() => {
    const saved = localStorage.getItem('activeFamily');
    return safeJSONParse(saved, null);
  });
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [isAuthReady, setIsAuthReady] = useState(false);
  const [showMemberForm, setShowMemberForm] = useState<{ member?: Member; parentId?: string; parentType?: 'father' | 'mother' } | null>(() => {
    const saved = localStorage.getItem('showMemberForm');
    return safeJSONParse(saved, null);
  });
  const [showFamilyForm, setShowFamilyForm] = useState<Family | boolean>(() => {
    const saved = localStorage.getItem('showFamilyForm');
    return safeJSONParse(saved, false);
  });
  const [isDownloading, setIsDownloading] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [highlightedMemberId, setHighlightedMemberId] = useState<string | null>(null);
  const [searchStatus, setSearchStatus] = useState<'idle' | 'found' | 'not-found'>('idle');
  const [isTranslating, setIsTranslating] = useState(false);
  const [bulkTranslationProgress, setBulkTranslationProgress] = useState<{ current: number; total: number } | null>(null);

  const translateToUrdu = async (text: string, fatherName?: string, gender?: string): Promise<string> => {
    if (!text) return text;
    // If it already has the separator, don't translate again
    if (text.includes(' | ')) return text;
    // Check if it's already mostly Urdu (simple heuristic: check for Urdu characters)
    const urduPattern = /[\u0600-\u06FF]/;
    if (urduPattern.test(text)) return text;

    setIsTranslating(true);
    try {
      let prompt = `Translate the following English text to Urdu. Only provide the Urdu translation, nothing else: "${text}"`;
      if (fatherName) {
        const relation = gender === 'female' ? 'daughter of' : 'son of';
        prompt = `Translate the following English name to Urdu. The person is ${text} and they are the ${relation} ${fatherName}. 
        Format the Urdu translation as "[Urdu Name] [Urdu Relation] [Urdu Father Name]". 
        Example: "John son of Peter" -> "جان ولد پیٹر". 
        Example: "Mary daughter of Peter" -> "مریم دختر پیٹر".
        Only provide the Urdu translation, nothing else.`;
      }

      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: prompt,
      });
      const urduText = response.text.trim();
      return `${text}   |   ${urduText}`;
    } catch (error) {
      console.error("Translation error:", error);
      return text;
    } finally {
      setIsTranslating(false);
    }
  };

  const bulkTranslateExisting = async () => {
    if (!activeFamily) return;
    
    const untranslatedMembers = members.filter(m => 
      (m.name && !m.name.includes('|') && !/[\u0600-\u06FF]/.test(m.name)) ||
      (m.address && !m.address.includes('|') && !/[\u0600-\u06FF]/.test(m.address))
    );

    if (untranslatedMembers.length === 0) {
      alert("All members are already translated! | تمام ممبران کا ترجمہ پہلے ہی ہو چکا ہے!");
      return;
    }

    setBulkTranslationProgress({ current: 0, total: untranslatedMembers.length });

    for (let i = 0; i < untranslatedMembers.length; i++) {
      const member = untranslatedMembers[i];
      const updates: any = {};
      
      if (member.name && !member.name.includes('|') && !/[\u0600-\u06FF]/.test(member.name)) {
        let fatherName = '';
        if (member.fatherId) {
          const father = members.find(m => m.id === member.fatherId);
          if (father) {
            // Use only the English part of the father's name for the prompt
            fatherName = father.name.split('|')[0].trim();
          }
        }
        updates.name = await translateToUrdu(member.name, fatherName, member.gender);
      }
      
      if (member.address && !member.address.includes('|') && !/[\u0600-\u06FF]/.test(member.address)) {
        updates.address = await translateToUrdu(member.address);
      }

      if (Object.keys(updates).length > 0) {
        try {
          await updateDoc(doc(db, `families/${activeFamily.id}/members`, member.id), updates);
        } catch (error) {
          console.error("Error updating member during bulk translate:", error);
        }
      }
      
      setBulkTranslationProgress({ current: i + 1, total: untranslatedMembers.length });
    }

    setBulkTranslationProgress(null);
    alert("Bulk translation completed! | خودکار ترجمہ مکمل ہو گیا!");
  };

  // Helper for safe JSON parsing
  function safeJSONParse(value: string | null, fallback: any) {
    if (!value || value === 'undefined') return fallback;
    try {
      return JSON.parse(value);
    } catch (e) {
      return fallback;
    }
  }

  // Helper for safe JSON stringify
  function safeStringify(obj: any) {
    const cache = new Set();
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (cache.has(value)) {
          return; // Circular reference found, discard key
        }
        cache.add(value);
      }
      return value;
    });
  }

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [duplicateConfirmed, setDuplicateConfirmed] = useState(false);

  useEffect(() => {
    localStorage.setItem('activeFamily', safeStringify(activeFamily));
  }, [activeFamily]);

  useEffect(() => {
    localStorage.setItem('showMemberForm', safeStringify(showMemberForm));
  }, [showMemberForm]);

  useEffect(() => {
    localStorage.setItem('showFamilyForm', safeStringify(showFamilyForm));
  }, [showFamilyForm]);

  const treeRef = useRef<SVGSVGElement>(null);
  const treeContainerRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<any>(null);
  const gRef = useRef<any>(null);

// --- Error Handling ---

enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId: string | undefined;
    email: string | null | undefined;
  }
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
    },
    operationType,
    path
  }
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Auth & Profile ---

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      setUser(currentUser);
      if (currentUser) {
        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        if (!userDoc.exists()) {
          const newProfile: UserProfile = {
            uid: currentUser.uid,
            displayName: currentUser.displayName || 'Anonymous',
            email: currentUser.email || '',
            photoURL: currentUser.photoURL || '',
            role: 'user'
          };
          await setDoc(doc(db, 'users', currentUser.uid), newProfile);
          setUserProfile(newProfile);
        } else {
          setUserProfile(userDoc.data() as UserProfile);
        }
      } else {
        setUserProfile(null);
      }
      setIsAuthReady(true);
      setLoading(false);
    });

    // Test connection
    const testConnection = async () => {
      try {
        await getDocFromServer(doc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Firebase connection error. Check configuration.");
        }
      }
    };
    testConnection();

    return () => unsubscribe();
  }, []);

  // --- Data Fetching ---

  useEffect(() => {
    if (!user) return;

    const q = query(collection(db, 'families'));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const familiesData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Family));
      setFamilies(familiesData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'families');
    });

    return () => unsubscribe();
  }, [user]);

  useEffect(() => {
    if (!activeFamily) {
      setMembers([]);
      return;
    }

    const q = query(collection(db, `families/${activeFamily.id}/members`));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const membersData = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Member));
      setMembers(membersData.sort((a, b) => {
        const serialA = parseInt(a.serialNumber || '9999');
        const serialB = parseInt(b.serialNumber || '9999');
        if (!isNaN(serialA) && !isNaN(serialB) && serialA !== serialB) {
          return serialA - serialB;
        }
        return (a.displayOrder || 0) - (b.displayOrder || 0);
      }));
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `families/${activeFamily.id}/members`);
    });

    return () => unsubscribe();
  }, [activeFamily]);

  // --- Tree Visualization ---

  useEffect(() => {
    if (!members.length || !treeRef.current) return;

    const svg = d3.select(treeRef.current as any);
    svg.selectAll("*").remove();

    svg.on("click", (event) => {
      if (event.target === treeRef.current) {
        setHighlightedMemberId(null);
        setSearchStatus('idle');
      }
    });

    const width = 1200;
    const height = 800;
    const margin = { top: 40, right: 90, bottom: 50, left: 90 };

    // Prepare data for D3 hierarchy
    // We'll use fatherId as the primary link for the shajra
    const stratify = d3.stratify<Member>()
      .id(d => d.id)
      .parentId(d => d.fatherId);

    try {
      // Find roots (members without fatherId or whose fatherId is not in the list)
      const memberIds = new Set(members.map(m => m.id));
      const roots = members.filter(m => !m.fatherId || !memberIds.has(m.fatherId));
      
      // If multiple roots, we wrap them in a virtual root
      let root;
      if (roots.length > 1) {
        const virtualRoot: any = { id: 'virtual-root', name: activeFamily?.name, isVirtual: true };
        const data = [virtualRoot, ...members.map(m => ({
          ...m,
          fatherId: (!m.fatherId || !memberIds.has(m.fatherId)) ? 'virtual-root' : m.fatherId
        }))];
        root = d3.stratify<any>().id(d => d.id).parentId(d => d.fatherId)(data);
      } else if (roots.length === 1) {
        root = stratify(members);
      } else {
        return;
      }

      const treeLayout = d3.tree()
        .nodeSize([280, 180]) // Increased spacing for better readability
        .separation((a, b) => (a.parent === b.parent ? 1.2 : 2)); // More space between different branches
      
      const treeData = treeLayout(root);

      // Center the tree horizontally based on its actual bounds
      let minX = 0, maxX = 0;
      treeData.descendants().forEach(d => {
        if (d.x < minX) minX = d.x;
        if (d.x > maxX) maxX = d.x;
      });
      const treeWidth = maxX - minX;

      const g = svg.append("g")
        .attr("transform", `translate(${width / 2},${margin.top})`);
      
      gRef.current = g;

      // Links
      g.selectAll(".link")
        .data(treeData.links())
        .enter().append("path")
        .attr("class", "link tree-link")
        .attr("fill", "none")
        .attr("stroke", "#b38b3f")
        .attr("stroke-opacity", 0.3)
        .attr("stroke-width", 2)
        .attr("d", d3.linkVertical()
          .x((d: any) => d.x)
          .y((d: any) => d.y) as any
        );

      // Nodes
      const node = g.selectAll(".node")
        .data(treeData.descendants())
        .enter().append("g")
        .attr("class", d => `node ${(d.data as any).id === highlightedMemberId ? 'search-highlight' : ''} ${d.children ? "node--internal" : "node--leaf"}`)
        .attr("id", d => `node-${(d.data as any).id}`)
        .attr("transform", d => `translate(${d.x},${d.y})`);

      node.append("circle")
        .attr("r", 8)
        .attr("fill", d => (d.data as any).isVirtual ? "#8E9299" : (d.data as Member).gender === 'male' ? "#0f1115" : "#b38b3f")
        .attr("stroke", "#fff")
        .attr("stroke-width", 2)
        .attr("cursor", "pointer")
        .attr("class", "node-button")
        .on("click", (event, d) => {
          if (!(d.data as any).isVirtual) {
            setHighlightedMemberId(null);
            setSearchStatus('idle');
            setFormError(null);
            setDuplicateConfirmed(false);
            setShowMemberForm({ member: d.data as Member });
          }
        })
        .append("title")
        .text(d => (d.data as any).isVirtual ? "Virtual Root" : `Click to edit ${(d.data as Member).name}`);

      node.append("text")
        .attr("dy", ".35em")
        .attr("x", 15)
        .attr("text-anchor", "start")
        .attr("font-family", "'Montserrat', sans-serif")
        .attr("font-size", "11px")
        .attr("font-weight", "600")
        .attr("fill", "#0f1115")
        .attr("cursor", "pointer")
        .on("click", (event, d) => {
          if (!(d.data as any).isVirtual) {
            setHighlightedMemberId(null);
            setSearchStatus('idle');
            setFormError(null);
            setDuplicateConfirmed(false);
            setShowMemberForm({ member: d.data as Member });
          }
        })
        .text(null) // Clear existing text
        .each(function(this: any, d: any) {
          const member = d.data as Member;
          const el = d3.select(this);
          
          let serial = member.serialNumber;
          if (!serial && d.parent && d.parent.children) {
            const index = d.parent.children.indexOf(d);
            serial = (index + 1).toString();
          }
          
          const fullName = member.name;
          const parts = fullName.split('|');
          const englishName = parts[0]?.trim() || '';
          const urduName = parts[1]?.trim() || '';
          const displayName = serial ? `${serial}. ${englishName}` : englishName;

          // English line
          el.append("tspan")
            .attr("x", 15)
            .attr("dy", "0em")
            .text(displayName);
          
          // Urdu line
          if (urduName) {
            el.append("tspan")
              .attr("x", 15)
              .attr("dy", "1.2em")
              .text(urduName);
          }
        })
        .each(function(this: any) {
          // Add a background rectangle to prevent overlap
          const bbox = (this as any).getBBox();
          d3.select(this.parentNode as any).insert("rect", "text")
            .attr("x", bbox.x - 12)
            .attr("y", bbox.y - 6)
            .attr("width", bbox.width + 24)
            .attr("height", bbox.height + 12)
            .attr("fill", "#f5f2ed")
            .attr("fill-opacity", 0.9)
            .attr("rx", 8);
        });

      // Zoom behavior
      const zoom = d3.zoom()
        .scaleExtent([0.1, 3])
        .on("zoom", (event) => {
          g.attr("transform", event.transform);
        });
      zoomRef.current = zoom;

      // Calculate initial scale to fit width if tree is very wide
      const initialScale = Math.min(1, (width - 100) / Math.max(treeWidth, 1));
      const initialTransform = d3.zoomIdentity
        .translate(width / 2, margin.top)
        .scale(initialScale);
        
      svg.call(zoom as any).call(zoom.transform as any, initialTransform);

    } catch (err) {
      console.error("D3 Stratify Error:", err);
    }

  }, [members, activeFamily, highlightedMemberId]);
  
  useEffect(() => {
    if (!treeRef.current || !zoomRef.current || !gRef.current) return;
    
    const svg = d3.select(treeRef.current as any);
    const width = 1200;
    const height = 800;

    if (searchStatus === 'found' && highlightedMemberId) {
      const targetNode = d3.select(`#node-${highlightedMemberId}`);
      if (!targetNode.empty()) {
        const d: any = targetNode.datum();
        const x = d.x;
        const y = d.y;
        
        const scale = 2;
        const transform = d3.zoomIdentity
          .translate(width / 2 - x * scale, height / 2 - y * scale)
          .scale(scale);
          
        svg.transition()
          .duration(1000)
          .call(zoomRef.current.transform, transform);
      }
    } else if (searchStatus === 'not-found') {
      // Zoom out
      const transform = d3.zoomIdentity
        .translate(width / 2, 40)
        .scale(0.5);
        
      svg.transition()
        .duration(1000)
        .call(zoomRef.current.transform, transform);
        
      // The red blink for "not found" will be handled by a React component overlay
      // to make it look nicer and easier to manage.
      setTimeout(() => setSearchStatus('idle'), 2000);
    }
  }, [highlightedMemberId, searchStatus]);

  // --- Handlers ---

  const handleLogin = async () => {
    try {
      await signInWithPopup(auth, googleProvider);
    } catch (error) {
      console.error("Login Error:", error);
    }
  };

  const handleLogout = () => signOut(auth);
  
  const performSearch = (term: string) => {
    if (!term.trim()) return;
    
    const found = members.find(m => 
      m.name.toLowerCase().includes(term.toLowerCase()) ||
      m.phoneNumber?.includes(term) ||
      m.serialNumber?.includes(term) ||
      m.address?.toLowerCase().includes(term.toLowerCase())
    );

    if (found) {
      setHighlightedMemberId(found.id);
      setSearchStatus('found');
      setShowSearch(false);
    } else {
      setSearchStatus('not-found');
      setShowSearch(false);
    }
  };

  const upsertFamily = async (name: string, description: string) => {
    if (!user) return;
    try {
      const familyData = {
        name,
        description,
        creatorId: user.uid,
        updatedAt: serverTimestamp()
      };

      if (typeof showFamilyForm === 'object' && showFamilyForm !== null) {
        await updateDoc(doc(db, 'families', showFamilyForm.id), familyData);
        if (activeFamily?.id === showFamilyForm.id) {
          setActiveFamily({ ...showFamilyForm, ...familyData });
        }
      } else {
        await addDoc(collection(db, 'families'), {
          ...familyData,
          createdAt: serverTimestamp()
        });
      }
      setShowFamilyForm(false);
    } catch (error) {
      handleFirestoreError(error, typeof showFamilyForm === 'object' ? OperationType.UPDATE : OperationType.CREATE, 'families');
    }
  };

  const addMember = async (memberData: Partial<Member>) => {
    if (!user || !activeFamily) return;

    // 1. Check for duplicate name among siblings (same father)
    if (memberData.fatherId) {
      const siblings = members.filter(m => 
        m.fatherId === memberData.fatherId && 
        m.id !== showMemberForm?.member?.id
      );
      
      const isDuplicateName = siblings.some(s => {
        const existingName = s.name.split('|')[0].trim().toLowerCase();
        const newName = (memberData.name || '').split('|')[0].trim().toLowerCase();
        return existingName === newName && newName !== '';
      });

      if (isDuplicateName) {
        setFormError("Duplicacy Error: This name already exists for another child of this parent. Please use a unique name. | ہم نامی کی غلطی: یہ نام اس والد کے کسی دوسرے بچے کے لیے پہلے سے موجود ہے۔ براہ کرم ایک منفرد نام استعمال کریں۔");
        return;
      }
    }

    // 2. Check for duplicate serial number within the family
    const isDuplicateSerial = members.some(m => 
      m.id !== showMemberForm?.member?.id && 
      m.serialNumber === memberData.serialNumber && 
      memberData.serialNumber && memberData.serialNumber.trim() !== ''
    );

    if (isDuplicateSerial) {
      setFormError("Duplicacy Error: This serial number is already assigned to another member. | ہم نامی کی غلطی: یہ سیریل نمبر پہلے سے کسی دوسرے ممبر کو دیا جا چکا ہے۔");
      return;
    }

    try {
      // Sanitize data: Firestore doesn't like 'undefined'
      const sanitizedData: any = {
        ...memberData,
        familyId: activeFamily.id,
        creatorId: user.uid,
      };
      
      // Remove undefined fields
      Object.keys(sanitizedData).forEach(key => {
        if (sanitizedData[key] === undefined) {
          delete sanitizedData[key];
        }
      });

      if (showMemberForm?.member) {
        await updateDoc(doc(db, `families/${activeFamily.id}/members`, showMemberForm.member.id), sanitizedData);
      } else {
        await addDoc(collection(db, `families/${activeFamily.id}/members`), sanitizedData);
      }
      setShowMemberForm(null);
    } catch (error) {
      handleFirestoreError(error, showMemberForm?.member ? OperationType.UPDATE : OperationType.CREATE, `families/${activeFamily.id}/members`);
    }
  };

  const deleteMember = async (memberId: string) => {
    if (!activeFamily) return;
    try {
      await deleteDoc(doc(db, `families/${activeFamily.id}/members`, memberId));
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, `families/${activeFamily.id}/members/${memberId}`);
    }
  };

  const handleReorder = async (newMembers: Member[]) => {
    if (!activeFamily) return;
    setMembers(newMembers);
    
    const batch = writeBatch(db);
    newMembers.forEach((member, index) => {
      const memberRef = doc(db, `families/${activeFamily.id}/members`, member.id);
      batch.update(memberRef, { displayOrder: index });
    });
    try {
      await batch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `families/${activeFamily.id}/members`);
    }
  };

  const updateMemberSerial = async (memberId: string, serialNumber: string) => {
    if (!activeFamily) return;
    try {
      await updateDoc(doc(db, `families/${activeFamily.id}/members`, memberId), { serialNumber });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, `families/${activeFamily.id}/members/${memberId}`);
    }
  };

  const downloadPDF = async () => {
    if (!treeRef.current || isDownloading) return;
    setIsDownloading(true);
    try {
      const svgElement = treeRef.current;
      const gElement = svgElement.querySelector('g');
      if (!gElement) throw new Error("Tree content not found");

      // Get the actual size of the tree content
      const bbox = gElement.getBBox();
      const padding = 100;
      const fullWidth = bbox.width + padding * 2;
      const fullHeight = bbox.height + padding * 2;

      const canvas = await html2canvas(treeContainerRef.current!, {
        scale: 2,
        useCORS: true,
        backgroundColor: '#faf9f6',
        logging: false,
        width: fullWidth,
        height: fullHeight,
        onclone: (clonedDoc) => {
          // Find the container in the cloned document
          const clonedContainer = clonedDoc.querySelector('.flex-1.overflow-hidden.relative') as HTMLElement;
          if (clonedContainer) {
            clonedContainer.style.width = `${fullWidth}px`;
            clonedContainer.style.height = `${fullHeight}px`;
            clonedContainer.style.overflow = 'visible';
            clonedContainer.style.position = 'relative';
          }

          const clonedSvg = clonedDoc.querySelector('svg') as SVGSVGElement;
          if (clonedSvg) {
            clonedSvg.style.width = `${fullWidth}px`;
            clonedSvg.style.height = `${fullHeight}px`;
            clonedSvg.setAttribute('width', `${fullWidth}`);
            clonedSvg.setAttribute('height', `${fullHeight}`);
            
            const clonedG = clonedSvg.querySelector('g');
            if (clonedG) {
              // Reset the transform and position the tree content
              clonedG.setAttribute('transform', `translate(${-bbox.x + padding}, ${-bbox.y + padding})`);
            }
            clonedSvg.setAttribute('viewBox', `0 0 ${fullWidth} ${fullHeight}`);
          }

          // Hide UI elements that shouldn't be in the PDF
          const legend = clonedDoc.querySelector('.absolute.bottom-8.right-8') as HTMLElement;
          if (legend) legend.style.display = 'none';
        }
      });
      
      const imgData = canvas.toDataURL('image/png');
      // jsPDF dimensions are in mm. 1px = 0.264583mm
      const mmWidth = fullWidth * 0.264583;
      const mmHeight = fullHeight * 0.264583;
      
      const pdf = new jsPDF({
        orientation: mmWidth > mmHeight ? 'l' : 'p',
        unit: 'mm',
        format: [mmWidth, mmHeight]
      });
      
      pdf.addImage(imgData, 'PNG', 0, 0, mmWidth, mmHeight);
      pdf.save(`${activeFamily?.name || 'shajra'}.pdf`);
    } catch (error) {
      console.error("PDF Download Error:", error);
    } finally {
      setIsDownloading(false);
    }
  };

  if (loading) return <LoadingSpinner />;

  if (!user) {
    return (
      <div className="min-h-screen bg-heritage-paper flex flex-col items-center justify-center p-6 text-center relative overflow-hidden">
        {/* Decorative Background Elements */}
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-heritage-gold/5 rounded-full blur-[120px]" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-heritage-gold/5 rounded-full blur-[120px]" />
        
        <motion.div 
          initial={{ opacity: 0, y: 30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: "easeOut" }}
          className="max-w-3xl bg-white/40 backdrop-blur-2xl p-16 rounded-[60px] shadow-[0_40px_100px_-20px_rgba(0,0,0,0.1)] border border-white/40 relative overflow-hidden"
        >
          <div className="absolute top-0 left-0 w-full h-1.5 bg-gradient-to-r from-transparent via-heritage-gold to-transparent opacity-50" />
          
          <div className="w-24 h-24 bg-heritage-dark rounded-[32px] flex items-center justify-center shadow-2xl shadow-heritage-dark/20 mx-auto mb-10">
            <TreePine className="w-12 h-12 text-heritage-gold" />
          </div>
          
          <h1 className="text-7xl font-serif font-black text-heritage-dark mb-8 tracking-tight leading-[1.1]">
            جوئیہ / راجپوت <br/>
            <span className="text-heritage-gold italic font-medium">شجرہ نصب</span>
          </h1>
          
          <p className="text-xl text-heritage-dark/50 mb-12 font-sans leading-relaxed max-w-lg mx-auto font-medium">
            اپنی برادری اور خاندان کی تاریخ کو ایک پریمیم اور خوبصورت انداز میں محفوظ بنائیں۔
          </p>
          
          <button
            onClick={handleLogin}
            className="flex items-center gap-4 bg-heritage-dark text-white px-12 py-6 rounded-full text-lg font-bold hover:bg-heritage-gold transition-all duration-500 shadow-[0_20px_40px_-10px_rgba(15,17,21,0.3)] hover:shadow-heritage-gold/30 group mx-auto"
          >
            <LogIn className="w-6 h-6 group-hover:translate-x-1 transition-transform" />
            Login with Google | گوگل کے ساتھ لاگ ان کریں
          </button>
          
          <div className="mt-20 grid grid-cols-3 gap-10">
            <div className="group">
              <div className="w-16 h-16 rounded-3xl bg-heritage-paper border border-heritage-gold/10 flex items-center justify-center mx-auto mb-4 group-hover:bg-heritage-gold group-hover:border-heritage-gold transition-all duration-500">
                <Users className="w-6 h-6 text-heritage-gold group-hover:text-white transition-colors" />
              </div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-heritage-dark/40">Community | کمیونٹی</p>
            </div>
            <div className="group">
              <div className="w-16 h-16 rounded-3xl bg-heritage-paper border border-heritage-gold/10 flex items-center justify-center mx-auto mb-4 group-hover:bg-heritage-gold group-hover:border-heritage-gold transition-all duration-500">
                <TreePine className="w-6 h-6 text-heritage-gold group-hover:text-white transition-colors" />
              </div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-heritage-dark/40">Tree | شجرہ</p>
            </div>
            <div className="group">
              <div className="w-16 h-16 rounded-3xl bg-heritage-paper border border-heritage-gold/10 flex items-center justify-center mx-auto mb-4 group-hover:bg-heritage-gold group-hover:border-heritage-gold transition-all duration-500">
                <Download className="w-6 h-6 text-heritage-gold group-hover:text-white transition-colors" />
              </div>
              <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-heritage-dark/40">Download | ڈاؤن لوڈ</p>
            </div>
          </div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="flex h-screen bg-heritage-paper font-sans text-heritage-dark overflow-hidden">
      {/* Sidebar Overlay for Mobile */}
      {isSidebarOpen && (
        <div className="fixed inset-0 bg-black/50 z-40 md:hidden" onClick={() => setIsSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <aside className={`fixed md:relative w-80 bg-white border-r border-heritage-gold/5 flex flex-col shadow-[20px_0_60px_-15px_rgba(0,0,0,0.03)] z-50 h-full transition-transform duration-500 ease-[cubic-bezier(0.4,0,0.2,1)] ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-10 border-b border-heritage-gold/5 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 bg-heritage-dark rounded-[20px] flex items-center justify-center shadow-xl shadow-heritage-dark/10">
              <TreePine className="w-7 h-7 text-heritage-gold" />
            </div>
            <div>
              <h2 className="text-2xl font-serif font-black leading-none tracking-tight">شجرہ نصب</h2>
              <p className="text-[9px] font-bold uppercase tracking-[0.3em] text-heritage-gold mt-1.5 opacity-80">Heritage Archive</p>
            </div>
          </div>
          <button className="md:hidden p-2 text-heritage-dark/20 hover:text-heritage-gold transition-colors" onClick={() => setIsSidebarOpen(false)}>
            <LogOut className="w-6 h-6" />
          </button>
        </div>
        
        <div className="p-8 border-b border-heritage-gold/5">
          <button 
            onClick={() => setShowFamilyForm(true)}
            className="w-full flex items-center justify-center gap-3 bg-heritage-dark text-white py-5 rounded-2xl text-sm font-bold hover:bg-heritage-gold transition-all duration-500 shadow-lg shadow-heritage-dark/10"
          >
            <Plus className="w-4 h-4" />
            Add Family | نیا خاندان شامل کریں
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-3 custom-scrollbar">
          <p className="px-4 text-[10px] font-bold uppercase tracking-[0.2em] text-heritage-dark/20 mb-6">آپ کے خاندان</p>
          {families.map(family => (
            <div key={family.id} className="group relative">
              <button
                onClick={() => setActiveFamily(family)}
                className={`w-full flex items-center justify-between p-5 rounded-[24px] transition-all duration-500 ${
                  activeFamily?.id === family.id 
                    ? 'bg-heritage-paper text-heritage-dark shadow-[0_10px_30px_-10px_rgba(179,139,63,0.2)] border border-heritage-gold/10' 
                    : 'hover:bg-heritage-cream text-heritage-dark/60'
                }`}
              >
                <div className="flex items-center gap-4 text-right">
                  <div className={`w-2.5 h-2.5 rounded-full transition-all duration-500 ${activeFamily?.id === family.id ? 'bg-heritage-gold scale-125 shadow-[0_0_10px_rgba(179,139,63,0.5)]' : 'bg-heritage-gold/20'}`} />
                  <div>
                    <p className="font-bold text-[15px] tracking-tight">{family.name}</p>
                    <p className={`text-[10px] font-bold mt-0.5 ${activeFamily?.id === family.id ? 'text-heritage-gold' : 'text-heritage-dark/30'}`}>
                      {members.filter(m => m.familyId === family.id).length} Members | ممبران
                    </p>
                  </div>
                </div>
                <ChevronRight className={`w-4 h-4 transition-all duration-500 ${activeFamily?.id === family.id ? 'text-heritage-gold translate-x-1' : 'text-heritage-dark/10 group-hover:translate-x-1'}`} />
              </button>
              <button 
                onClick={(e) => {
                  e.stopPropagation();
                  setShowFamilyForm(family);
                }}
                className="absolute left-14 top-1/2 -translate-y-1/2 p-2.5 opacity-0 group-hover:opacity-100 text-heritage-gold hover:bg-heritage-gold/10 rounded-xl transition-all duration-300"
              >
                <Edit2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>

        <div className="p-8 border-t border-heritage-gold/5 bg-heritage-paper/20 space-y-4">
          <button 
            onClick={bulkTranslateExisting}
            disabled={!!bulkTranslationProgress}
            className="w-full flex items-center justify-center gap-3 py-4 bg-heritage-gold/10 text-heritage-gold rounded-2xl text-[11px] font-bold uppercase tracking-[0.2em] hover:bg-heritage-gold hover:text-white transition-all duration-500 disabled:opacity-50"
          >
            {bulkTranslationProgress ? (
              `Translating ${bulkTranslationProgress.current}/${bulkTranslationProgress.total}...`
            ) : (
              <>
                <Share2 className="w-4 h-4" />
                Translate All | سب کا ترجمہ کریں
              </>
            )}
          </button>
          <div className="flex items-center gap-4">
            <div className="relative">
              <img src={userProfile?.photoURL} alt="" className="w-12 h-12 rounded-2xl border-2 border-heritage-gold/20 p-0.5 object-cover" referrerPolicy="no-referrer" />
              <div className="absolute -bottom-1 -right-1 w-4 h-4 bg-green-500 border-2 border-white rounded-full" />
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-bold truncate tracking-tight">{userProfile?.displayName}</p>
              <p className="text-[10px] font-bold text-heritage-dark/30 truncate uppercase tracking-wider">{userProfile?.role}</p>
            </div>
            <button onClick={handleLogout} className="p-2.5 text-heritage-dark/20 hover:text-red-500 hover:bg-red-50 rounded-xl transition-all duration-300">
              <LogOut className="w-4.5 h-4.5" />
            </button>
          </div>
        </div>
      </aside>

        {/* Main Content Area */}
        <section className="flex-1 flex flex-col bg-[#f5f2ed] relative">
          {!activeFamily ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center">
              <div className="w-40 h-40 bg-white rounded-[40px] flex items-center justify-center shadow-2xl shadow-heritage-gold/5 border border-heritage-gold/10 mb-10">
                <TreePine className="w-20 h-20 text-heritage-gold/20" />
              </div>
              <h2 className="text-5xl font-serif font-black text-heritage-dark mb-4 tracking-tight">Select a Family | خاندان کا انتخاب کریں</h2>
              <p className="text-lg text-heritage-dark/40 max-w-lg mx-auto font-medium leading-relaxed">
                Please select a family from the sidebar or create a new one to begin. <br/>
                براہ کرم بائیں جانب سے کسی خاندان کا انتخاب کریں یا نیا خاندان بنا کر شجرہ شروع کریں۔
              </p>
            </div>
          ) : (
            <>
              {/* Toolbar */}
              <header className="bg-white/60 backdrop-blur-3xl border-b border-heritage-gold/5 px-12 py-6 flex items-center justify-between sticky top-0 z-40">
                <div className="flex items-center gap-6">
                  <div className="flex flex-col">
                    <h1 className="text-4xl font-serif font-black text-heritage-dark tracking-tight">{activeFamily.name}</h1>
                    <p className="text-[11px] font-bold text-heritage-gold uppercase tracking-[0.2em] mt-2 opacity-80">{activeFamily.description || 'خاندانی شجرہ نصب کی مکمل تفصیلات'}</p>
                  </div>
                  <button 
                    onClick={() => setShowFamilyForm(activeFamily)}
                    className="p-3 text-heritage-dark/10 hover:text-heritage-gold hover:bg-heritage-gold/5 rounded-2xl transition-all duration-500"
                    title="Edit Family"
                  >
                    <Edit2 className="w-5 h-5" />
                  </button>
                </div>

                <div className="flex items-center gap-3">
                  <button className="md:hidden p-2.5 bg-heritage-paper rounded-xl text-heritage-dark/40" onClick={() => setIsSidebarOpen(true)}>
                    <Users className="w-5 h-5" />
                  </button>
                  
                  <button 
                    onClick={() => {
                      setFormError(null);
                      setDuplicateConfirmed(false);
                      setShowMemberForm({});
                    }}
                    className="flex items-center gap-2 bg-heritage-dark text-white px-5 py-2.5 rounded-xl text-[12px] font-bold hover:bg-heritage-gold transition-all duration-500 shadow-lg shadow-heritage-dark/10"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Member | ممبر شامل کریں
                  </button>

                  <button 
                    onClick={() => setShowSearch(true)}
                    className="flex items-center gap-2 bg-white text-heritage-dark border border-heritage-gold/10 px-5 py-2.5 rounded-xl text-[12px] font-bold hover:bg-heritage-paper transition-all duration-500 shadow-sm"
                  >
                    <Search className="w-3.5 h-3.5 text-heritage-gold" />
                    Search | تلاش کریں
                  </button>

                  <button 
                    onClick={downloadPDF}
                    disabled={isDownloading}
                    className={`flex items-center gap-2 bg-white text-heritage-dark border border-heritage-gold/10 px-5 py-2.5 rounded-xl text-[12px] font-bold hover:bg-heritage-paper transition-all duration-500 shadow-sm ${isDownloading ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    {isDownloading ? (
                      <motion.div
                        animate={{ rotate: 360 }}
                        transition={{ duration: 1, repeat: Infinity, ease: "linear" }}
                        className="w-3.5 h-3.5 border-2 border-heritage-gold border-t-transparent rounded-full"
                      />
                    ) : (
                      <Download className="w-3.5 h-3.5 text-heritage-gold" />
                    )}
                    {isDownloading ? 'Preparing... | تیار ہو رہا ہے...' : 'Download PDF | PDF ڈاؤن لوڈ کریں'}
                  </button>
                </div>
              </header>

              {/* Tree View */}
              <div className="flex-1 overflow-hidden relative" ref={treeContainerRef}>
                <AnimatePresence>
                  {searchStatus === 'not-found' && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: [0, 0.4, 0, 0.4, 0] }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 1.5 }}
                      className="absolute inset-0 bg-red-500 z-10 pointer-events-none"
                    />
                  )}
                </AnimatePresence>
                <svg 
                  ref={treeRef} 
                  className="w-full h-full cursor-grab active:cursor-grabbing"
                  viewBox="0 0 1200 800"
                />
                
              {/* Legend */}
              <div className="absolute bottom-12 right-12 bg-white/40 backdrop-blur-2xl p-8 rounded-[40px] border border-white/40 space-y-4 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.1)]">
                <div className="flex items-center gap-3 text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold mb-4">
                  <Info className="w-4 h-4" />
                  Legend | وضاحت
                </div>
                <div className="flex items-center gap-5">
                  <div className="w-5 h-5 rounded-full bg-heritage-dark shadow-xl shadow-heritage-dark/20 border-2 border-white" />
                  <span className="text-sm font-bold tracking-tight">Male | مرد</span>
                </div>
                <div className="flex items-center gap-5">
                  <div className="w-5 h-5 rounded-full bg-heritage-gold shadow-xl shadow-heritage-gold/20 border-2 border-white" />
                  <span className="text-sm font-bold tracking-tight">Female | عورت</span>
                </div>
              </div>
              </div>
            </>
          )}
        </section>

      {/* Modals */}
      <AnimatePresence>
        {showSearch && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSearch(false)}
              className="absolute inset-0 bg-[#141414]/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-2xl p-10 rounded-[48px] shadow-[0_40px_100px_-20px_rgba(0,0,0,0.2)] border border-heritage-gold/10 flex flex-col max-h-[80vh]"
            >
              <div className="flex items-center justify-between mb-8">
                <h3 className="text-3xl font-serif font-black text-heritage-dark tracking-tight">
                  Search Members | ممبر تلاش کریں
                </h3>
                <button 
                  onClick={() => setShowSearch(false)}
                  className="p-3 hover:bg-heritage-paper rounded-2xl transition-colors"
                >
                  <Plus className="w-6 h-6 rotate-45 text-heritage-dark/30" />
                </button>
              </div>

              <div className="relative mb-8">
                <Search className="absolute left-6 top-1/2 -translate-y-1/2 w-5 h-5 text-heritage-gold" />
                <input 
                  autoFocus
                  type="text"
                  placeholder="Enter name, phone, or serial... | نام، فون یا سیریل درج کریں..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      performSearch(searchTerm);
                    }
                  }}
                  className="w-full pl-16 pr-8 py-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium text-lg"
                />
              </div>

              <div className="flex-1 overflow-y-auto custom-scrollbar space-y-4 pr-2">
                {searchTerm.trim() === '' ? (
                  <div className="text-center py-12 text-heritage-dark/30 font-medium">
                    Start typing to search... | تلاش کرنے کے لیے لکھنا شروع کریں...
                  </div>
                ) : members.filter(m => 
                  m.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                  m.phoneNumber?.includes(searchTerm) ||
                  m.serialNumber?.includes(searchTerm) ||
                  m.address?.toLowerCase().includes(searchTerm.toLowerCase())
                ).length === 0 ? (
                  <div className="text-center py-12 text-heritage-dark/30 font-medium">
                    No members found. | کوئی ممبر نہیں ملا۔
                  </div>
                ) : (
                  members.filter(m => 
                    m.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
                    m.phoneNumber?.includes(searchTerm) ||
                    m.serialNumber?.includes(searchTerm) ||
                    m.address?.toLowerCase().includes(searchTerm.toLowerCase())
                  ).map(member => (
                    <button
                      key={member.id}
                      onClick={() => {
                        setHighlightedMemberId(member.id);
                        setSearchStatus('found');
                        setFormError(null);
                        setDuplicateConfirmed(false);
                        setShowSearch(false);
                        setSearchTerm('');
                      }}
                      className="w-full flex items-center gap-6 p-6 bg-heritage-paper/50 hover:bg-heritage-paper rounded-[32px] transition-all group text-left"
                    >
                      <div className={`w-14 h-14 rounded-2xl flex items-center justify-center shadow-lg transition-transform group-hover:scale-110 ${member.gender === 'female' ? 'bg-heritage-gold text-white' : 'bg-heritage-dark text-white'}`}>
                        <UserIcon className="w-6 h-6" />
                      </div>
                      <div className="flex-1">
                        <h4 className="text-lg font-bold text-heritage-dark">{member.name}</h4>
                        <div className="flex gap-4 mt-1">
                          {member.serialNumber && (
                            <span className="text-[10px] font-bold uppercase tracking-widest text-heritage-gold">
                              #{member.serialNumber}
                            </span>
                          )}
                          {member.phoneNumber && (
                            <span className="text-[10px] font-bold uppercase tracking-widest text-heritage-dark/40">
                              {member.phoneNumber}
                            </span>
                          )}
                        </div>
                      </div>
                      <ChevronRight className="w-5 h-5 text-heritage-gold opacity-0 group-hover:opacity-100 transition-all -translate-x-2 group-hover:translate-x-0" />
                    </button>
                  ))
                )}
              </div>
            </motion.div>
          </div>
        )}

        {showFamilyForm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowFamilyForm(false)}
              className="absolute inset-0 bg-[#141414]/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-md p-12 rounded-[48px] shadow-[0_40px_100px_-20px_rgba(0,0,0,0.2)] border border-heritage-gold/10"
            >
              <h3 className="text-4xl font-serif font-black mb-10 text-heritage-dark tracking-tight">
                {typeof showFamilyForm === 'object' ? 'Family Info | خاندان کی معلومات' : 'New Family | نیا خاندان'}
              </h3>
              <form onSubmit={(e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                upsertFamily(formData.get('name') as string, formData.get('description') as string);
              }} className="space-y-8">
                <div className="space-y-3">
                  <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Family Name | خاندان کا نام</label>
                  <input 
                    name="name" 
                    defaultValue={typeof showFamilyForm === 'object' ? showFamilyForm.name : ''} 
                    required 
                    className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium" 
                    placeholder="e.g. Joyia Family Sahiwal | مثلاً: جوئیہ فیملی ساہیوال"
                    onBlur={async (e) => {
                      const translated = await translateToUrdu(e.target.value);
                      e.target.value = translated;
                    }}
                  />
                </div>
                <div className="space-y-3">
                  <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Description | تفصیل</label>
                  <textarea 
                    name="description" 
                    defaultValue={typeof showFamilyForm === 'object' ? showFamilyForm.description : ''} 
                    className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 h-40 transition-all font-medium resize-none" 
                    placeholder="Some info about the family... | خاندان کے بارے میں کچھ معلومات..."
                    onBlur={async (e) => {
                      const translated = await translateToUrdu(e.target.value);
                      e.target.value = translated;
                    }}
                  />
                </div>
                <div className="flex gap-5 pt-6">
                  <button type="button" onClick={() => setShowFamilyForm(false)} className="flex-1 py-6 rounded-[24px] font-bold text-heritage-dark/30 hover:bg-heritage-paper transition-all duration-500">Cancel | کینسل</button>
                  <button type="submit" className="flex-2 py-6 rounded-[24px] font-bold bg-heritage-dark text-white hover:bg-heritage-gold transition-all duration-500 shadow-xl shadow-heritage-dark/10">Save | محفوظ کریں</button>
                </div>
              </form>
            </motion.div>
          </div>
        )}

        {showMemberForm && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowMemberForm(null)}
              className="absolute inset-0 bg-[#141414]/60 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ scale: 0.95, opacity: 0, y: 20 }}
              animate={{ scale: 1, opacity: 1, y: 0 }}
              exit={{ scale: 0.95, opacity: 0, y: 20 }}
              className="relative bg-white w-full max-w-2xl p-12 rounded-[48px] shadow-[0_40px_100px_-20px_rgba(0,0,0,0.2)] overflow-y-auto max-h-[90vh] custom-scrollbar border border-heritage-gold/10"
            >
              <div className="flex items-center justify-between mb-12">
                <h3 className="text-4xl font-serif font-black text-heritage-dark tracking-tight">
                  {showMemberForm.member ? 'Member Info | معلومات ممبر' : 'New Member | نیا ممبر'}
                </h3>
                {formError && (
                  <motion.div 
                    initial={{ opacity: 0, y: -10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="absolute top-32 left-12 right-12 bg-red-50 text-red-600 p-4 rounded-2xl text-xs font-bold border border-red-100 flex items-center gap-3 z-10"
                  >
                    <Info className="w-4 h-4 shrink-0" />
                    {formError}
                  </motion.div>
                )}
                <div className="w-16 h-16 bg-heritage-paper rounded-3xl flex items-center justify-center">
                  <UserIcon className="w-8 h-8 text-heritage-gold" />
                </div>
              </div>
              
              <form onSubmit={(e) => {
                e.preventDefault();
                const formData = new FormData(e.currentTarget);
                addMember({
                  name: formData.get('name') as string,
                  gender: formData.get('gender') as any,
                  fatherId: formData.get('fatherId') as string || "",
                  motherId: formData.get('motherId') as string || "",
                  birthDate: formData.get('birthDate') as string || "",
                  deathDate: formData.get('deathDate') as string || "",
                  phoneNumber: formData.get('phoneNumber') as string || "",
                  serialNumber: formData.get('serialNumber') as string || "",
                  photoURL: formData.get('photoURL') as string || "",
                  address: formData.get('address') as string || "",
                });
              }} className="space-y-10">
                <div className="grid grid-cols-12 gap-8">
                  <div className="col-span-12 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Name | نام</label>
                    <textarea 
                      name="name" 
                      defaultValue={showMemberForm.member?.name} 
                      required 
                      className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium text-lg resize-none"
                      style={{ direction: 'ltr', minHeight: '80px' }}
                      onChange={() => {
                        setFormError(null);
                        setDuplicateConfirmed(false);
                      }}
                      onBlur={async (e) => {
                        const form = e.target.form;
                        if (!form) return;
                        const formData = new FormData(form);
                        const fatherId = formData.get('fatherId') as string;
                        const gender = formData.get('gender') as string;
                        let fatherName = '';
                        if (fatherId) {
                          const father = members.find(m => m.id === fatherId);
                          if (father) fatherName = father.name.split('|')[0].trim();
                        }
                        const translated = await translateToUrdu(e.target.value, fatherName, gender);
                        e.target.value = translated;
                      }}
                    />
                  </div>
                  <div className="col-span-4 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Gender | جنس</label>
                    <select name="gender" defaultValue={showMemberForm.member?.gender || 'male'} className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium appearance-none">
                      <option value="male">Male | مرد</option>
                      <option value="female">Female | عورت</option>
                      <option value="other">Other | دیگر</option>
                    </select>
                  </div>
                  <div className="col-span-12 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Father | والد</label>
                    <select 
                      name="fatherId" 
                      defaultValue={showMemberForm.parentType === 'father' ? showMemberForm.parentId : showMemberForm.member?.fatherId} 
                      onChange={() => {
                        setFormError(null);
                        setDuplicateConfirmed(false);
                      }}
                      className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium appearance-none"
                    >
                      <option value="">None | کوئی نہیں</option>
                      {members.filter(m => m.gender === 'male' && m.id !== showMemberForm.member?.id).map(m => {
                        const parts = m.name.split('|');
                        const englishName = parts[0]?.trim() || '';
                        const urduName = parts[1]?.trim() || '';
                        const displayName = urduName ? `${englishName} | ${urduName}` : englishName;
                        return <option key={m.id} value={m.id}>{displayName}</option>;
                      })}
                    </select>
                  </div>
                  <div className="col-span-12 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Mother | والدہ</label>
                    <select name="motherId" defaultValue={showMemberForm.parentType === 'mother' ? showMemberForm.parentId : showMemberForm.member?.motherId} className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium appearance-none">
                      <option value="">None | کوئی نہیں</option>
                      {members.filter(m => m.gender === 'female' && m.id !== showMemberForm.member?.id).map(m => {
                        const parts = m.name.split('|');
                        const englishName = parts[0]?.trim() || '';
                        const urduName = parts[1]?.trim() || '';
                        const displayName = urduName ? `${englishName} | ${urduName}` : englishName;
                        return <option key={m.id} value={m.id}>{displayName}</option>;
                      })}
                    </select>
                  </div>
                  <div className="col-span-6 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Birth Date | تاریخ پیدائش</label>
                    <input type="date" name="birthDate" defaultValue={showMemberForm.member?.birthDate} className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium" />
                  </div>
                  <div className="col-span-6 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Death Date | تاریخ وفات</label>
                    <input type="date" name="deathDate" defaultValue={showMemberForm.member?.deathDate} className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium" />
                  </div>
                  <div className="col-span-6 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Serial Number | سیریل نمبر</label>
                    <div className="flex gap-3">
                      <input id="serialNumberInput" name="serialNumber" defaultValue={showMemberForm.member?.serialNumber} className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium" />
                      <button 
                        type="button"
                        onClick={() => {
                          const maxSerial = Math.max(...members.map(m => parseInt(m.serialNumber || '0')), 0);
                          const input = document.getElementById('serialNumberInput') as HTMLInputElement;
                          if (input) input.value = (maxSerial + 1).toString();
                        }}
                        className="p-6 bg-heritage-dark text-white rounded-[24px] hover:bg-heritage-gold transition-all duration-500 shadow-lg shadow-heritage-dark/10"
                      >
                        <Plus className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                  <div className="col-span-6 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Phone Number | فون نمبر</label>
                    <input name="phoneNumber" defaultValue={showMemberForm.member?.phoneNumber} className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium" />
                  </div>
                  <div className="col-span-12 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Photo URL | تصویر کا لنک</label>
                    <input name="photoURL" defaultValue={showMemberForm.member?.photoURL} className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 transition-all font-medium" />
                  </div>
                  <div className="col-span-12 space-y-3">
                    <label className="block text-[10px] font-bold uppercase tracking-[0.3em] text-heritage-gold ml-4">Address | رہائشی پتہ</label>
                    <textarea 
                      name="address" 
                      defaultValue={showMemberForm.member?.address} 
                      className="w-full p-6 bg-heritage-paper rounded-[24px] border-none focus:ring-2 focus:ring-heritage-gold/20 h-32 transition-all font-medium resize-none"
                      onBlur={async (e) => {
                        const translated = await translateToUrdu(e.target.value);
                        e.target.value = translated;
                      }}
                    />
                  </div>
                </div>
                <div className="flex gap-5 pt-8">
                  <button type="button" onClick={() => setShowMemberForm(null)} className="flex-1 py-6 rounded-[24px] font-bold text-heritage-dark/30 hover:bg-heritage-paper transition-all duration-500">Cancel | کینسل</button>
                  <button type="submit" className="flex-2 py-6 rounded-[24px] font-bold bg-heritage-dark text-white hover:bg-heritage-gold transition-all duration-500 shadow-xl shadow-heritage-dark/10">Save | محفوظ کریں</button>
                </div>
              </form>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
